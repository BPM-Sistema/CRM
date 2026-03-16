-- =====================================================
-- Migración 034: WhatsApp Testing Mode Config
-- Configura modo testing de WhatsApp como feature flag
-- =====================================================

-- 1. Agregar columna metadata para configs que necesitan datos extra (ej: teléfono testing)
ALTER TABLE integration_config ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- 2. Insertar config de WhatsApp testing
INSERT INTO integration_config (key, enabled, description, category, metadata) VALUES
  ('whatsapp_testing_mode', true, 'Modo testing: los mensajes se envían solo al número configurado, no al cliente real', 'whatsapp', '{"testing_phone": "1123945965"}')
ON CONFLICT (key) DO NOTHING;
