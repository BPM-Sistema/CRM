-- 065: botmaker_message_id en whatsapp_messages
-- Motivación: el webhook de delivery de Botmaker envía el campo `messageId`
-- (formato: 6V0RABKRBOEJKVQ4W6QI), que es el ID que identifica el mensaje
-- en el pipeline de Botmaker/Meta. Nosotros hasta ahora solo guardábamos
-- nuestro propio `request_id` (UUID local), por lo que el match del
-- webhook fallaba silenciosamente (UPDATE afectaba 0 filas).
--
-- Fix: agregar columna y el worker la popula con response.data.requestId
-- al completar el send. El webhook matchea por botmaker_message_id.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS botmaker_message_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_botmaker_message_id
  ON whatsapp_messages (botmaker_message_id)
  WHERE botmaker_message_id IS NOT NULL;
