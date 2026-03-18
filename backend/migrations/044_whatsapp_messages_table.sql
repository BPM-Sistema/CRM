-- =====================================================
-- Migración 044: Crear tabla whatsapp_messages (si no existe)
-- Tracking de mensajes WhatsApp enviados via Botmaker
-- =====================================================

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(100) NOT NULL UNIQUE,
  order_number INTEGER,
  template VARCHAR(100) NOT NULL,
  contact_id VARCHAR(50) NOT NULL,
  variables JSONB,
  status VARCHAR(20) DEFAULT 'pending',
  status_updated_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
