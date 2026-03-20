-- Migration: Catalog-based template system
-- Purpose: Replace hardcoded/suffix-based template logic with explicit mappings
-- This enables full configurability from the admin panel without code changes

-- ============================================
-- 1. CREATE CATALOG TABLE (plantilla_tipos)
-- ============================================
CREATE TABLE IF NOT EXISTS plantilla_tipos (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL CHECK (key ~ '^[a-z_]+$'),  -- lowercase + underscore only
  nombre TEXT NOT NULL,                                 -- display name for UI
  descripcion TEXT,                                     -- help text for admins
  requiere_variante BOOLEAN NOT NULL DEFAULT true,      -- false = universal (same for all financieras)
  plantilla_default TEXT NOT NULL,                      -- fallback template name
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE plantilla_tipos IS 'Catalog of WhatsApp template types. Configurable from admin panel.';
COMMENT ON COLUMN plantilla_tipos.key IS 'Unique identifier used in code (e.g., pedido_creado)';
COMMENT ON COLUMN plantilla_tipos.requiere_variante IS 'If true, each financiera can have its own template. If false, same template for all.';
COMMENT ON COLUMN plantilla_tipos.plantilla_default IS 'Fallback template name if financiera has no specific mapping';

-- ============================================
-- 2. CREATE MAPPING TABLE (financiera_plantillas)
-- ============================================
CREATE TABLE IF NOT EXISTS financiera_plantillas (
  id SERIAL PRIMARY KEY,
  financiera_id INTEGER NOT NULL REFERENCES financieras(id) ON DELETE CASCADE,
  plantilla_tipo_id INTEGER NOT NULL REFERENCES plantilla_tipos(id) ON DELETE CASCADE,
  nombre_botmaker TEXT NOT NULL CHECK (length(nombre_botmaker) > 0),  -- exact name in Botmaker
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(financiera_id, plantilla_tipo_id)
);

COMMENT ON TABLE financiera_plantillas IS 'Explicit mapping of template names per financiera. No dynamic string construction.';
COMMENT ON COLUMN financiera_plantillas.nombre_botmaker IS 'Exact template name as configured in Botmaker';

-- Index for fast lookups by financiera
CREATE INDEX IF NOT EXISTS idx_financiera_plantillas_financiera
ON financiera_plantillas(financiera_id);

-- ============================================
-- 3. SEED CATALOG WITH KNOWN TEMPLATE TYPES
-- ============================================
INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('pedido_creado', 'Pedido Creado', 'Se envía cuando se crea un nuevo pedido. Incluye datos de transferencia.', true, 'pedido_creado'),
  ('partial_paid', 'Pago Parcial', 'Se envía cuando se confirma un comprobante con pago parcial. Incluye datos de transferencia.', true, 'partial_paid'),
  ('datos__envio', 'Datos de Envío', 'Se envía para solicitar datos de envío al cliente.', false, 'datos__envio'),
  ('comprobante_rechazado', 'Comprobante Rechazado', 'Se envía cuando se rechaza un comprobante.', false, 'comprobante_rechazado'),
  ('comprobante_confirmado', 'Comprobante Confirmado', 'Se envía cuando se confirma un comprobante.', false, 'comprobante_confirmado'),
  ('enviado_env_nube', 'Enviado Envío Nube', 'Se envía cuando el pedido se marca como enviado via Envío Nube.', false, 'enviado_env_nube'),
  ('enviado_transporte', 'Enviado Transporte', 'Se envía cuando se confirma el remito de transporte.', false, 'enviado_transporte'),
  ('pedido_cancelado', 'Pedido Cancelado', 'Se envía cuando se cancela un pedido.', false, 'pedido_cancelado')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 4. MIGRATE EXISTING DATA FROM plantilla_sufijo
-- ============================================
-- For each financiera with plantilla_sufijo, create mappings for variante templates
INSERT INTO financiera_plantillas (financiera_id, plantilla_tipo_id, nombre_botmaker)
SELECT
  f.id AS financiera_id,
  pt.id AS plantilla_tipo_id,
  pt.key || '_' || f.plantilla_sufijo AS nombre_botmaker
FROM financieras f
CROSS JOIN plantilla_tipos pt
WHERE f.plantilla_sufijo IS NOT NULL
  AND f.plantilla_sufijo != ''
  AND pt.requiere_variante = true
ON CONFLICT (financiera_id, plantilla_tipo_id) DO NOTHING;

-- ============================================
-- 5. DROP OLD COLUMN (after verification)
-- ============================================
-- NOTE: We keep plantilla_sufijo for now as safety net
-- Run this manually after verifying the migration:
-- ALTER TABLE financieras DROP COLUMN IF EXISTS plantilla_sufijo;
