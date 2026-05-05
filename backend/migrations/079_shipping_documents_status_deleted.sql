-- 079: agregar estado 'deleted' a shipping_documents.status
--
-- El handler DELETE /remitos/:id ahora hace soft delete (UPDATE status='deleted')
-- en vez de DELETE fisico. Razon: el cron de Drive intake usa el UNIQUE parcial
-- sobre source_drive_file_id para evitar reingestar archivos. Si borraramos la
-- fila, el proximo run del cron volveria a ingestar el mismo archivo de Drive.
-- Con soft delete la fila persiste y el pre-check del cron sigue detectando el
-- fileId.
--
-- Idempotente: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT recrea el check con
-- el array extendido.

ALTER TABLE shipping_documents
  DROP CONSTRAINT IF EXISTS shipping_documents_status_check;

ALTER TABLE shipping_documents
  ADD CONSTRAINT shipping_documents_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'processing'::text,
    'ready'::text,
    'confirmed'::text,
    'rejected'::text,
    'error'::text,
    'deleted'::text
  ]));
