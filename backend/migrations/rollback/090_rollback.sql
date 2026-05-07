-- Rollback de 090_estados_pedido_constraints.sql
-- Quita los dos CHECK constraints. Los datos quedan intactos.

BEGIN;

ALTER TABLE orders_validated DROP CONSTRAINT IF EXISTS chk_estado_pedido;
ALTER TABLE orders_validated DROP CONSTRAINT IF EXISTS chk_pago_consistente;

COMMIT;
