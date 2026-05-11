-- Rollback de 096_warehouse_stock_issues.sql
-- Atención: borra el histórico completo de issues. Solo correr si el
-- rollback es deliberado.

BEGIN;

DROP TABLE IF EXISTS warehouse_stock_issues;

COMMIT;
