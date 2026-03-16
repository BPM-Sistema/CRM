-- =====================================================
-- Migración 035: Toggles individuales para plantillas WhatsApp
-- Permite habilitar/deshabilitar cada plantilla desde integraciones
-- =====================================================

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('whatsapp_tpl_pedido_creado',          true, 'Notificar al cliente cuando se crea un pedido nuevo', 'whatsapp'),
  ('whatsapp_tpl_comprobante_confirmado', true, 'Notificar al cliente cuando se confirma su comprobante de pago', 'whatsapp'),
  ('whatsapp_tpl_comprobante_rechazado',  true, 'Notificar al cliente cuando se rechaza su comprobante de pago', 'whatsapp'),
  ('whatsapp_tpl_datos_envio',            true, 'Solicitar datos de envío al cliente después de confirmar pago', 'whatsapp'),
  ('whatsapp_tpl_enviado_env_nube',       true, 'Notificar al cliente que su pedido fue despachado (Envío Nube)', 'whatsapp'),
  ('whatsapp_tpl_pedido_cancelado',       true, 'Notificar al cliente que su pedido fue cancelado', 'whatsapp'),
  ('whatsapp_tpl_partial_paid',           true, 'Notificar al cliente que tiene saldo pendiente de pago', 'whatsapp'),
  ('whatsapp_tpl_enviado_transporte',     false, 'Notificar envío por transporte (NO IMPLEMENTADA)', 'whatsapp')
ON CONFLICT (key) DO NOTHING;
