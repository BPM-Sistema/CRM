-- Migration: Add confirmed_by to comprobantes
-- Tracks which user confirmed each comprobante

ALTER TABLE comprobantes
ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;

-- Index for querying by user
CREATE INDEX IF NOT EXISTS idx_comprobantes_confirmed_by ON comprobantes(confirmed_by);

COMMENT ON COLUMN comprobantes.confirmed_by IS 'User ID who confirmed this comprobante';
COMMENT ON COLUMN comprobantes.confirmed_at IS 'Timestamp when comprobante was confirmed';
