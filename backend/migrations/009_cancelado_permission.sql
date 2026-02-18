-- =====================================================
-- AGREGAR PERMISO PARA ESTADO cancelado
-- =====================================================

-- Agregar el permiso
INSERT INTO permissions (key, module) VALUES
  ('orders.view_cancelado', 'orders_estado')
ON CONFLICT (key) DO NOTHING;

-- Asignar a ADMIN
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'orders.view_cancelado'
ON CONFLICT DO NOTHING;

-- Asignar a OPERADOR
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'operador' AND p.key = 'orders.view_cancelado'
ON CONFLICT DO NOTHING;

-- Asignar a LOGISTICA
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'logistica' AND p.key = 'orders.view_cancelado'
ON CONFLICT DO NOTHING;

-- Asignar a READONLY
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'readonly' AND p.key = 'orders.view_cancelado'
ON CONFLICT DO NOTHING;
