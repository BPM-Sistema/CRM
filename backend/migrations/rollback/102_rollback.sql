-- Rollback de 102_pending_sheet_pushes.sql
-- Borra tabla + indexes. La cola se pierde — si hay pushes pendientes
-- mejor procesarlos primero antes de rollback.

BEGIN;

DROP INDEX IF EXISTS uniq_pending_sheet_pushes_order_pending;
DROP INDEX IF EXISTS idx_pending_sheet_pushes_pending_enqueued_at;
DROP TABLE IF EXISTS pending_sheet_pushes;

COMMIT;
