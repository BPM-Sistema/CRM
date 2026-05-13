-- Rollback de 099_estado_thresholds.sql
-- Borra la tabla completa. Los topes configurados se pierden.

BEGIN;

DROP TABLE IF EXISTS estado_thresholds;

COMMIT;
