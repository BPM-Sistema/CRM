-- =====================================================
-- RBAC SEEDS
-- =====================================================

-- =====================================================
-- PERMISOS
-- =====================================================

INSERT INTO permissions (key, module) VALUES
  -- Dashboard
  ('dashboard.view', 'dashboard'),

  -- Orders
  ('orders.view', 'orders'),
  ('orders.print', 'orders'),
  ('orders.update_status', 'orders'),
  ('orders.create_cash_payment', 'orders'),

  -- Receipts
  ('receipts.view', 'receipts'),
  ('receipts.download', 'receipts'),
  ('receipts.upload_manual', 'receipts'),
  ('receipts.confirm', 'receipts'),
  ('receipts.reject', 'receipts'),

  -- Users
  ('users.view', 'users'),
  ('users.create', 'users'),
  ('users.edit', 'users'),
  ('users.disable', 'users'),
  ('users.assign_role', 'users')
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- ROLES
-- =====================================================

INSERT INTO roles (name) VALUES
  ('admin'),
  ('operador'),
  ('caja'),
  ('logistica'),
  ('readonly')
ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- ASIGNACIÓN DE PERMISOS A ROLES
-- =====================================================

-- ADMIN: todos los permisos
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- OPERADOR: dashboard + orders + receipts (excepto upload_manual)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'operador'
  AND p.key IN (
    'dashboard.view',
    'orders.view',
    'orders.print',
    'orders.update_status',
    'orders.create_cash_payment',
    'receipts.view',
    'receipts.download',
    'receipts.confirm',
    'receipts.reject'
  )
ON CONFLICT DO NOTHING;

-- CAJA: dashboard + receipts + orders.create_cash_payment
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'caja'
  AND p.key IN (
    'dashboard.view',
    'orders.view',
    'orders.create_cash_payment',
    'receipts.view',
    'receipts.download',
    'receipts.confirm',
    'receipts.reject'
  )
ON CONFLICT DO NOTHING;

-- LOGISTICA: dashboard + orders (view, print, update_status)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'logistica'
  AND p.key IN (
    'dashboard.view',
    'orders.view',
    'orders.print',
    'orders.update_status'
  )
ON CONFLICT DO NOTHING;

-- READONLY: solo view
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'readonly'
  AND p.key IN (
    'dashboard.view',
    'orders.view',
    'receipts.view'
  )
ON CONFLICT DO NOTHING;

-- =====================================================
-- USUARIO ADMIN POR DEFECTO
-- Password: admin123 (bcrypt hash con cost 10)
-- Hash generado con: bcrypt.hashSync('admin123', 10)
-- =====================================================

INSERT INTO users (name, email, password_hash, role_id, is_active)
SELECT
  'Administrador',
  'admin@petlove.com',
  '$2b$10$vI8aWBnW3fID.ZQ4/zo1G.q1lRps.9cGLcZEiGDMVr5yUP1KUOYTa',
  r.id,
  true
FROM roles r
WHERE r.name = 'admin'
ON CONFLICT (email) DO NOTHING;
