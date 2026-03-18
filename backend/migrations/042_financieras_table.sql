-- =====================================================
-- Migración 042: Crear tabla financieras (si no existe)
-- Cuentas bancarias registradas para validar comprobantes
-- =====================================================

CREATE TABLE IF NOT EXISTS financieras (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT,
  titular_principal TEXT,
  celular TEXT,
  palabras_clave JSONB,
  activa BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  cbu TEXT,
  porcentaje NUMERIC,
  alias TEXT,
  is_default BOOLEAN DEFAULT false,
  datos_transferencia TEXT
);
