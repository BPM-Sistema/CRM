-- Rollback de 093_whatsapp_triggers_estado.sql

BEGIN;

DELETE FROM integration_config
WHERE key IN (
  'empaquetado_pendiente_pago',
  'pendiente_datos_envio',
  'pendiente_retiro_aviso'
);

COMMIT;
