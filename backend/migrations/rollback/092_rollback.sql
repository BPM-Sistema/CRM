-- Rollback de 092_orders_tester_permission.sql

BEGIN;

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE key = 'orders.tester');

DELETE FROM permissions WHERE key = 'orders.tester';

COMMIT;
