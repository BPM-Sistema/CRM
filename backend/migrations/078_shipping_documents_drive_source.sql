-- 078: trazabilidad de origen para shipping_documents.
--
-- Hasta ahora todos los remitos venian del flujo manual (operador subiendo
-- por la UI). Sumamos un cron de Drive que ingresa archivos automaticamente,
-- y necesitamos:
--   - distinguir manual vs drive en la DB para reportes/UI
--   - guardar el fileId de Drive para idempotencia entre corridas del cron
--     (UNIQUE parcial: si dos corridas concurrentes intentan ingresar el
--     mismo fileId, solo una gana via INSERT ... ON CONFLICT DO NOTHING)
--   - guardar el folderId para poder agrupar/auditar por carpeta diaria

ALTER TABLE shipping_documents
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_drive_file_id TEXT,
  ADD COLUMN IF NOT EXISTS source_drive_folder_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_documents_drive_file_id
  ON shipping_documents(source_drive_file_id)
  WHERE source_drive_file_id IS NOT NULL;
