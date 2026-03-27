-- =====================================================
-- Migración 049: Botmaker Channel Config
-- Permite configurar el canal de WhatsApp desde el panel
-- =====================================================

-- Insertar config para el canal de Botmaker
INSERT INTO integration_config (key, enabled, description, category, metadata)
VALUES (
  'botmaker_channel',
  true,
  'Canal de WhatsApp Business (número desde el cual se envían mensajes)',
  'whatsapp',
  '{"channel_id": "blanqueriaxmayor-whatsapp-5491136914124"}'
)
ON CONFLICT (key) DO NOTHING;
