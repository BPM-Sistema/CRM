-- Agregar numero_operacion para detectar duplicados por operación bancaria
ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS numero_operacion TEXT;

-- Índice para búsqueda rápida de duplicados
CREATE INDEX IF NOT EXISTS idx_comprobantes_numero_operacion ON comprobantes (numero_operacion) WHERE numero_operacion IS NOT NULL;
