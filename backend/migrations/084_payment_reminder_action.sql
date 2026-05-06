-- Migration 084: Acción de Melu en panel de payment-reminders
-- Cuando el cliente clickea CARGAR COMPROBANTE pero no carga nada, Melu puede:
--   - Cancelar el pedido (en CRM y TN con restock=true)
--   - Esperar y dejar nota (ej "dice que va a pagar")
-- Una vez aplicada la acción, los botones desaparecen del panel.

ALTER TABLE orders_validated
  ADD COLUMN IF NOT EXISTS payment_reminder_note TEXT,
  ADD COLUMN IF NOT EXISTS payment_reminder_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_reminder_action_type TEXT
    CHECK (payment_reminder_action_type IN ('cancel', 'wait') OR payment_reminder_action_type IS NULL);

CREATE INDEX IF NOT EXISTS idx_orders_validated_payment_reminder_action_at
  ON orders_validated (payment_reminder_action_at)
  WHERE payment_reminder_action_at IS NOT NULL;
