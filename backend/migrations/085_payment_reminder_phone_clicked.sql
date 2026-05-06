-- Migration 085: marca cuándo se hizo click en el teléfono del panel
-- Cuando Melu clickea el teléfono del cliente en /admin/payment-reminders,
-- se abre Botmaker para verificar si pagó. Al volver al panel, ese pedido
-- debe mostrar los botones Cancelar/Esperar para que pueda actuar.
-- Es global (cualquier admin que clickee marca), no por usuario.

ALTER TABLE orders_validated
  ADD COLUMN IF NOT EXISTS phone_clicked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_validated_phone_clicked_at
  ON orders_validated (phone_clicked_at)
  WHERE phone_clicked_at IS NOT NULL;
