-- Add fecha_comprobante column to store the date from the receipt itself (not upload date)
ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS fecha_comprobante DATE;
