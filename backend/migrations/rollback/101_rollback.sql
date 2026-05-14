-- Rollback de 101_order_reprints.sql
-- Borra la tabla y el index.
-- Nota: borra el historial de motivos. Considerá dump previo si necesitás
-- preservarlo.

BEGIN;

DROP INDEX IF EXISTS idx_order_reprints_order;
DROP TABLE IF EXISTS order_reprints;

COMMIT;
