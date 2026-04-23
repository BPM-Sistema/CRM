-- 064_abre_chat_to_saludo_reabrir_sara.sql
-- Reemplaza el template Meta detrás del tipo "abre_chat" (key interna) por
-- "saludo_reabrir_sara". La key interna se mantiene para no romper llamadas
-- existentes a queueWhatsApp({ plantilla: 'abre_chat' }).

UPDATE plantilla_tipos
   SET plantilla_default = 'saludo_reabrir_sara',
       nombre = 'Saludo — Reabrir chat',
       descripcion = 'Mensaje de saludo sin variables para reabrir conversación con el cliente (reemplaza abre_chat).'
 WHERE key = 'abre_chat'
   AND plantilla_default = 'abre_chat';
