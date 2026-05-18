-- 104: Reorganizar permisos bajo el módulo "marketing".
--
-- Contexto: hoy el sidebar tiene un item "Stock Alerts" suelto. Lo movemos
-- bajo un grupo "Marketing" (Stock Alerts + Reseñas Google) y reorganizamos
-- los permisos para que reflejen esa estructura.
--
-- Cambios:
--   1. Crear los 4 permisos nuevos del módulo marketing.
--   2. A todos los roles que tenían stock_alerts.view, asignarles marketing.stock.view.
--   3. A todos los roles que tenían stock_alerts.manage, asignarles marketing.stock.send.
--   4. NO borramos los permisos viejos (stock_alerts.*) — los dejamos por
--      compatibilidad durante 1 release. El código que los chequea sigue funcionando.
--      En una migración futura (post-rollout) los borraremos.
--
-- Idempotente: ON CONFLICT en todos los INSERT.

BEGIN;

-- 1. Crear permisos nuevos del módulo marketing.
INSERT INTO permissions (key, module) VALUES
  ('marketing.stock.view',     'marketing'),
  ('marketing.stock.send',     'marketing'),
  ('marketing.reviews.view',   'marketing'),
  ('marketing.reviews.send',   'marketing')
ON CONFLICT (key) DO NOTHING;

-- 2. Roles que tenían stock_alerts.view → reciben marketing.stock.view.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_new.id
FROM role_permissions rp
JOIN permissions p_old ON p_old.id = rp.permission_id AND p_old.key = 'stock_alerts.view'
CROSS JOIN permissions p_new
WHERE p_new.key = 'marketing.stock.view'
ON CONFLICT DO NOTHING;

-- 3. Roles que tenían stock_alerts.manage → reciben marketing.stock.send.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_new.id
FROM role_permissions rp
JOIN permissions p_old ON p_old.id = rp.permission_id AND p_old.key = 'stock_alerts.manage'
CROSS JOIN permissions p_new
WHERE p_new.key = 'marketing.stock.send'
ON CONFLICT DO NOTHING;

-- 4. Admin tiene todo — asegurar que admin también recibe marketing.reviews.*
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'admin'
  AND p.key IN ('marketing.reviews.view', 'marketing.reviews.send')
ON CONFLICT DO NOTHING;

COMMIT;
