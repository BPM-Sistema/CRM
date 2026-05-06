-- Migration 086: customer_phone override por verificación del cliente
--
-- Cuando un cliente nos contacta desde un WhatsApp distinto al cargado en TN,
-- el operador le pasa el link /comprobantes-wpp donde el cliente confirma su
-- número real. Este timestamp marca que ese phone fue verificado por el
-- cliente y NO debe ser sobreescrito por webhooks posteriores de TN.

ALTER TABLE orders_validated
  ADD COLUMN IF NOT EXISTS customer_phone_overridden_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_validated_customer_phone_overridden
  ON orders_validated (customer_phone_overridden_at)
  WHERE customer_phone_overridden_at IS NOT NULL;

COMMENT ON COLUMN orders_validated.customer_phone_overridden_at IS
  'Timestamp del último override manual del cliente vía /comprobantes-wpp. Si está seteado, los webhooks de TN y el divergence-detector no sobreescriben customer_phone.';
