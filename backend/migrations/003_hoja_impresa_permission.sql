-- =====================================================
-- AGREGAR PERMISO PARA ESTADO hoja_impresa
-- =====================================================

-- Agregar el permiso
INSERT INTO permissions (key, module) VALUES
  ('orders.view_hoja_impresa', 'orders_estado')
ON CONFLICT (key) DO NOTHING;

-- Asignar a ADMIN (todos los permisos ya lo tienen por el query dinámico)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'orders.view_hoja_impresa'
ON CONFLICT DO NOTHING;

-- Asignar a OPERADOR
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'operador' AND p.key = 'orders.view_hoja_impresa'
ON CONFLICT DO NOTHING;

-- Asignar a LOGISTICA
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'logistica' AND p.key = 'orders.view_hoja_impresa'
ON CONFLICT DO NOTHING;

-- Asignar a READONLY
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'readonly' AND p.key = 'orders.view_hoja_impresa'
ON CONFLICT DO NOTHING;
