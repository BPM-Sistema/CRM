-- =====================================================
-- SHIPPING REQUESTS HISTÓRICO
-- Datos importados desde Google Sheets (formulario previo a la app).
-- Se usa solo para alimentar el ranking de transportes por provincia.
-- =====================================================

CREATE TABLE IF NOT EXISTS shipping_requests_historico (
  id SERIAL PRIMARY KEY,
  order_number TEXT,
  empresa_envio_raw TEXT,
  provincia TEXT,
  localidad TEXT,
  created_at TIMESTAMPTZ,
  fuente TEXT DEFAULT 'google_sheets_2026'
);

CREATE INDEX IF NOT EXISTS idx_srh_provincia ON shipping_requests_historico(provincia);
CREATE INDEX IF NOT EXISTS idx_srh_fuente ON shipping_requests_historico(fuente);
