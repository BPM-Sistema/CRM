-- Migration: Add plantilla_sufijo column to financieras
-- Purpose: Eliminate hardcoded template suffix logic (wanda_v2, kiesel_v2, etc.)
-- The suffix is now stored in the database, making the system flexible and maintainable.

-- Add column for WhatsApp template suffix
ALTER TABLE financieras
ADD COLUMN IF NOT EXISTS plantilla_sufijo TEXT;

-- Migrate existing data based on current hardcoded logic
-- This preserves backward compatibility
UPDATE financieras
SET plantilla_sufijo = 'wanda_v2'
WHERE LOWER(nombre) LIKE '%wanda%' AND plantilla_sufijo IS NULL;

UPDATE financieras
SET plantilla_sufijo = 'kiesel_v2'
WHERE LOWER(nombre) LIKE '%kiesel%' AND plantilla_sufijo IS NULL;

-- Add comment explaining the column
COMMENT ON COLUMN financieras.plantilla_sufijo IS
'Suffix appended to WhatsApp template names (e.g., "wanda_v2" -> pedido_creado_wanda_v2). NULL means no suffix.';
