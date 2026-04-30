-- 075: agregar uploaded_by a shipping_documents para saber quien subio cada
-- remito y poder mostrarlo en la UI sin abrir el remito.
--
-- Hasta ahora solo quedaba en logs (accion='remito_subido') sin link directo
-- al documento. Para los remitos viejos hacemos backfill matcheando por
-- timestamp cercano (±60s).

ALTER TABLE shipping_documents
  ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users(id);

-- Backfill: por cada shipping_document, buscar el log 'remito_subido' mas
-- cercano en tiempo (±60s) que tenga user_id. Si no hay log cercano queda NULL.
UPDATE shipping_documents sd
SET uploaded_by = (
  SELECT l.user_id
  FROM logs l
  WHERE l.accion = 'remito_subido'
    AND l.user_id IS NOT NULL
    AND l.created_at BETWEEN sd.created_at - INTERVAL '60 seconds'
                         AND sd.created_at + INTERVAL '60 seconds'
  ORDER BY ABS(EXTRACT(EPOCH FROM (l.created_at - sd.created_at)))
  LIMIT 1
)
WHERE sd.uploaded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_shipping_documents_uploaded_by
  ON shipping_documents(uploaded_by);
