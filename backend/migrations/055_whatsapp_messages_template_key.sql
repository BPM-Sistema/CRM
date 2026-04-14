-- Add template_key column to whatsapp_messages
-- Stores the original plantilla key (e.g., 'comprobante_confirmado')
-- separate from template which stores the resolved name (e.g., 'numero_viejo_comprobante_confirmado_v2')

ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS template_key VARCHAR(100);

-- Backfill template_key from template for existing records
UPDATE whatsapp_messages
SET template_key = REGEXP_REPLACE(REGEXP_REPLACE(template, '^numero_viejo_', ''), '_v\d+$', '')
WHERE template_key IS NULL;

-- Mark stale pending messages (older than 4 hours) as 'unknown'
-- These were likely sent by the old worker but never had their status updated
UPDATE whatsapp_messages
SET status = 'unknown', status_updated_at = NOW()
WHERE status = 'pending'
AND created_at < NOW() - INTERVAL '4 hours';
