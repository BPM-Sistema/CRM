-- =====================================================
-- SHIPPING DOCUMENTS - Carga masiva de remitos
-- =====================================================

CREATE TABLE IF NOT EXISTS shipping_documents (
  id SERIAL PRIMARY KEY,

  -- Archivo
  file_url TEXT NOT NULL,
  file_name TEXT,
  file_type TEXT, -- 'image/jpeg', 'image/png', 'application/pdf'

  -- OCR
  ocr_text TEXT,
  ocr_processed_at TIMESTAMP,

  -- Datos detectados
  detected_name TEXT,
  detected_address TEXT,
  detected_city TEXT,

  -- Matching
  suggested_order_number TEXT REFERENCES orders_validated(order_number),
  match_score DECIMAL(5,4), -- 0.0000 a 1.0000
  match_details JSONB, -- { name_score: 0.85, address_score: 0.90 }

  -- Confirmación
  confirmed_order_number TEXT REFERENCES orders_validated(order_number),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TIMESTAMP,

  -- Estado
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'confirmed', 'rejected', 'error')),
  error_message TEXT,

  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_shipping_documents_status ON shipping_documents(status);
CREATE INDEX IF NOT EXISTS idx_shipping_documents_suggested_order ON shipping_documents(suggested_order_number);
CREATE INDEX IF NOT EXISTS idx_shipping_documents_confirmed_order ON shipping_documents(confirmed_order_number);
CREATE INDEX IF NOT EXISTS idx_shipping_documents_created_at ON shipping_documents(created_at DESC);

COMMENT ON TABLE shipping_documents IS 'Remitos de envío cargados masivamente con OCR y matching automático';
