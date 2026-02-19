-- =====================================================
-- COMPROBANTES: Agregar columna financiera_id
-- =====================================================
-- Almacena la financiera detectada/asociada al comprobante
-- para permitir filtrado y agrupación por cuenta de destino.

ALTER TABLE comprobantes
ADD COLUMN IF NOT EXISTS financiera_id INTEGER REFERENCES financieras(id);

-- Índice para búsquedas rápidas por financiera
CREATE INDEX IF NOT EXISTS idx_comprobantes_financiera_id ON comprobantes(financiera_id);
