-- Migration 082: Tabla whatsapp_inbound_messages
-- Almacena mensajes ENTRANTES de clientes vía webhook de Botmaker
-- (webhook tipo "Mensajes y estados de mensaje" con check "Mensajes del usuario").
-- Permite ver en el CRM si el cliente respondió a una plantilla, qué dijo y
-- si clickeó botones URL (ej. "CARGAR COMPROBANTE").

CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
  id SERIAL PRIMARY KEY,
  contact_id VARCHAR(50) NOT NULL,        -- número del cliente (ej "+5491123456789")
  chat_id VARCHAR(100),                   -- chatId de Botmaker
  message_id VARCHAR(100),                -- _id único del mensaje (puede ser null en algunos eventos)
  message_type VARCHAR(50) NOT NULL,      -- 'text' | 'button' | 'image' | 'url_click' | 'event' | 'other'
  message_text TEXT,                      -- contenido textual si aplica
  button_id VARCHAR(200),                 -- ID del botón si fue button reply
  url_clicked TEXT,                       -- URL clickeada si message_type = 'url_click'
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload JSONB,                      -- payload completo de Botmaker para debugging
  order_number INTEGER                    -- correlación con pedido (best-effort por phone)
);

-- Dedup: mismo message_id no se inserta dos veces. Solo aplica si message_id no es null.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_inbound_message_id
  ON whatsapp_inbound_messages (message_id)
  WHERE message_id IS NOT NULL;

-- Búsqueda por phone + tiempo para correlacionar con plantillas enviadas.
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_contact_received
  ON whatsapp_inbound_messages (contact_id, received_at DESC);

-- Búsqueda por pedido para el panel de recordatorios.
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_order_number
  ON whatsapp_inbound_messages (order_number)
  WHERE order_number IS NOT NULL;
