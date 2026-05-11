-- =====================================================
-- Migración 094: corrige 093 — crear como plantillas en plantilla_tipos
--
-- La migration 093 creó 3 entries directos en integration_config como
-- toggles "huérfanos", pero el panel /admin/integrations renderiza desde
-- plantilla_tipos (cada plantilla auto-crea su toggle whatsapp_tpl_<key>).
-- Por eso los 3 toggles de 093 no aparecían en el panel.
--
-- Esta migration:
--   1. Crea 3 rows nuevas en plantilla_tipos. plantilla_default apunta al
--      mismo template Botmaker que las plantillas existentes reutilizadas
--      hasta que se creen templates custom.
--   2. Crea los toggles whatsapp_tpl_aviso_<key> (siguen la convención).
--   3. Elimina los 3 toggles huérfanos creados por la migration 093.
--
-- Idempotente.
-- =====================================================

BEGIN;

-- 1. Plantillas nuevas (apuntan a templates Botmaker existentes — reutilización).
INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('aviso_empaquetado_pendiente_pago',
   'Empaquetado — Pendiente de Pago',
   'Aviso al cliente cuando el pedido pasa a empaquetado pero el pago aún no está confirmado total (Fase 2). Reutiliza template pendiente_3hs hasta que se cree un template custom.',
   false,
   'pendiente_3hs'),
  ('aviso_pendiente_datos_envio',
   'Pendiente Datos de Envío',
   'Aviso al cliente cuando el pedido pasa a pendiente_datos_envio (Fase 2). Reutiliza template datos__envio hasta que se cree un template custom.',
   false,
   'datos__envio'),
  ('aviso_pendiente_retiro',
   'Pendiente Retiro — Aviso',
   'Aviso al cliente cuando el pedido pasa a pendiente_retiro (Fase 2). Reutiliza template retiros_local hasta que se cree un template custom.',
   false,
   'retiros_local')
ON CONFLICT (key) DO NOTHING;

-- 2. Toggles (convención whatsapp_tpl_<plantilla_key>).
INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('whatsapp_tpl_aviso_empaquetado_pendiente_pago',
   true,
   'Enviar WhatsApp: Empaquetado — Pendiente de Pago',
   'whatsapp'),
  ('whatsapp_tpl_aviso_pendiente_datos_envio',
   true,
   'Enviar WhatsApp: Pendiente Datos de Envío',
   'whatsapp'),
  ('whatsapp_tpl_aviso_pendiente_retiro',
   true,
   'Enviar WhatsApp: Pendiente Retiro — Aviso',
   'whatsapp')
ON CONFLICT (key) DO NOTHING;

-- 3. Limpiar toggles huérfanos de migration 093.
DELETE FROM integration_config
WHERE key IN (
  'empaquetado_pendiente_pago',
  'pendiente_datos_envio',
  'pendiente_retiro_aviso'
);

COMMIT;
