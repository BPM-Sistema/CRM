-- Rollback de 095_warehouse_schema.sql
-- Atención: borrar warehouse_state_transitions y warehouse_users elimina
-- TODO el log histórico de actividad del depo. Solo correr si el rollback
-- es deliberado.

BEGIN;

-- 1. Permisos RBAC.
DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE key LIKE 'deposito.%');
DELETE FROM permissions WHERE key LIKE 'deposito.%';

-- 2. Columna bultos.
ALTER TABLE orders_validated DROP CONSTRAINT IF EXISTS chk_bultos_positivo;
ALTER TABLE orders_validated DROP COLUMN IF EXISTS bultos;

-- 3. Tablas (orden inverso a la creación por las FKs).
DROP TABLE IF EXISTS warehouse_state_transitions;
DROP TABLE IF EXISTS warehouse_user_permissions;
DROP TABLE IF EXISTS warehouse_users;

COMMIT;
