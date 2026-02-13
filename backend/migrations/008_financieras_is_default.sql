-- =====================================================
-- FINANCIERAS: Agregar columna is_default + permisos RBAC
-- =====================================================

-- Agregar columna is_default si no existe
ALTER TABLE financieras ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;

-- =====================================================
-- PERMISOS DE FINANCIERAS
-- =====================================================

INSERT INTO permissions (key, module) VALUES
  ('financieras.view', 'financieras'),
  ('financieras.create', 'financieras'),
  ('financieras.update', 'financieras'),
  ('financieras.delete', 'financieras'),
  ('financieras.set_default', 'financieras')
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- ASIGNAR PERMISOS AL ROL ADMIN
-- =====================================================

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.key IN (
    'financieras.view',
    'financieras.create',
    'financieras.update',
    'financieras.delete',
    'financieras.set_default'
  )
ON CONFLICT DO NOTHING;

-- =====================================================
-- ASIGNAR PERMISOS AL ROL OPERADOR (solo view)
-- =====================================================

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'operador'
  AND p.key IN ('financieras.view')
ON CONFLICT DO NOTHING;
