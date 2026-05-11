-- Rollback de 094_whatsapp_triggers_estado_plantilla_tipos.sql
-- Restaura los toggles huérfanos de 093 y elimina las plantillas + toggles
-- creados en 094.

BEGIN;

-- 1. Restaurar los 3 toggles huérfanos como estaban en 093.
INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('empaquetado_pendiente_pago',
   true,
   'Disparar WhatsApp cuando el pedido entra a empaquetado con pago pendiente (Fase 2)',
   'whatsapp'),
  ('pendiente_datos_envio',
   true,
   'Disparar WhatsApp cuando el pedido entra a pendiente_datos_envio (Fase 2)',
   'whatsapp'),
  ('pendiente_retiro_aviso',
   true,
   'Disparar WhatsApp cuando el pedido entra a pendiente_retiro (Fase 2)',
   'whatsapp')
ON CONFLICT (key) DO NOTHING;

-- 2. Borrar los toggles whatsapp_tpl_aviso_*.
DELETE FROM integration_config WHERE key IN (
  'whatsapp_tpl_aviso_empaquetado_pendiente_pago',
  'whatsapp_tpl_aviso_pendiente_datos_envio',
  'whatsapp_tpl_aviso_pendiente_retiro'
);

-- 3. Borrar las 3 plantillas de plantilla_tipos.
DELETE FROM plantilla_tipos WHERE key IN (
  'aviso_empaquetado_pendiente_pago',
  'aviso_pendiente_datos_envio',
  'aviso_pendiente_retiro'
);

COMMIT;
