-- =====================================================
-- Migración 093: toggles para 3 disparadores nuevos de WhatsApp
--
-- Fase 2 PR 1: agregamos 3 disparadores que mandan un WhatsApp cuando el
-- pedido entra a ciertos estados nuevos. Cada disparador tiene su propio
-- toggle independiente.
--
-- Importante — diferencia con los toggles whatsapp_tpl_*:
--   * `whatsapp_tpl_<plantilla>` (existentes) controlan la PLANTILLA, vía el
--     helper `enviarWhatsAppPlantilla`. Apagar uno desactiva TODA emisión de
--     esa plantilla, venga del lugar que venga.
--   * Los 3 toggles de esta migración controlan el DISPARADOR específico
--     (qué transición de estado dispara el envío). Por ahora todos usan
--     plantillas existentes reutilizadas (pendiente_3hs / datos__envio /
--     retiros_local); cuando se creen plantillas custom en Botmaker, solo
--     hay que cambiar el `plantilla` en el helper `notify-estado-transition`,
--     los toggles siguen funcionando igual.
--
-- Reutilización temporal de plantillas:
--   empaquetado_pendiente_pago  →  pendiente_3hs   (recordatorio de pago)
--   pendiente_datos_envio        →  datos__envio    (link al formulario)
--   pendiente_retiro_aviso       →  retiros_local   (vení a retirar)
--
-- Idempotente.
-- =====================================================

BEGIN;

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

COMMIT;
