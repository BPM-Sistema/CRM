-- =====================================================
-- REMITOS PERMISSIONS
-- =====================================================

-- Agregar permisos para remitos
INSERT INTO permissions (key, module) VALUES
  ('remitos.view', 'remitos'),
  ('remitos.upload', 'remitos'),
  ('remitos.confirm', 'remitos'),
  ('remitos.reject', 'remitos'),
  ('remitos.reprocess', 'remitos')
ON CONFLICT (key) DO NOTHING;

-- Asignar permisos a admin (todos)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.module = 'remitos'
ON CONFLICT DO NOTHING;

-- Asignar permisos a operador (todos excepto reprocess)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'operador'
  AND p.key IN (
    'remitos.view',
    'remitos.upload',
    'remitos.confirm',
    'remitos.reject'
  )
ON CONFLICT DO NOTHING;

-- Asignar permisos a logistica (view, upload, confirm, reject)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'logistica'
  AND p.key IN (
    'remitos.view',
    'remitos.upload',
    'remitos.confirm',
    'remitos.reject'
  )
ON CONFLICT DO NOTHING;
