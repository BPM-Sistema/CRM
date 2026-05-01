-- 076: agregar tracking_number a shipping_documents.
--
-- N° de seguimiento del transporte (la "guía" en jerga Vía Cargo). Permite
-- armar el link directo de seguimiento desde la UI:
--   https://formularios.viacargo.com.ar/seguimiento-envio/{tracking_number}
--
-- Se completa al procesar el remito (Claude Vision en `numero_guia`, o
-- regex sobre OCR como fallback). Backfill no se hace acá: los remitos
-- viejos quedan con NULL hasta que se reprocese si hace falta.

ALTER TABLE shipping_documents
  ADD COLUMN IF NOT EXISTS tracking_number TEXT;

CREATE INDEX IF NOT EXISTS idx_shipping_documents_tracking_number
  ON shipping_documents(tracking_number)
  WHERE tracking_number IS NOT NULL;
