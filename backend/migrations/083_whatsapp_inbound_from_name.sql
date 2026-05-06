-- Migration 083: agrega from_name a whatsapp_inbound_messages
-- Botmaker manda mensajes inbound con shape plano (no array), donde el campo
-- "from" es literal "user" (no el phone) y el nombre del cliente viene en
-- "fromName". Sin from_name no podemos identificar al cliente en el panel.

ALTER TABLE whatsapp_inbound_messages
  ADD COLUMN IF NOT EXISTS from_name TEXT;

-- Backfill desde raw_payload para los registros existentes.
UPDATE whatsapp_inbound_messages
SET from_name = raw_payload->>'fromName'
WHERE from_name IS NULL AND raw_payload ? 'fromName';

-- Si contact_id quedo como 'user' (parser viejo), tambien intentar poblarlo
-- con un identificador estable: usa _id_ + fromName si contact_id no es phone.
-- Esto es solo backfill — el handler nuevo ya guarda from_name directo.
