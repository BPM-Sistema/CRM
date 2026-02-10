-- =====================================================
-- RBAC SEEDS
-- =====================================================

-- =====================================================
-- PERMISOS
-- =====================================================

INSERT INTO permissions (key, module) VALUES
  -- Dashboard
  ('dashboard.view', 'dashboard'),

  -- Orders (general)
  ('orders.view', 'orders'),
  ('orders.print', 'orders'),
  ('orders.update_status', 'orders'),
  ('orders.create_cash_payment', 'orders'),

  -- Orders por estado de pago
  ('orders.view_pendiente', 'orders_pago'),
  ('orders.view_a_confirmar', 'orders_pago'),
  ('orders.view_parcial', 'orders_pago'),
  ('orders.view_total', 'orders_pago'),
  ('orders.view_rechazado', 'orders_pago'),

  -- Orders por estado de pedido
  ('orders.view_pendiente_pago', 'orders_estado'),
  ('orders.view_a_imprimir', 'orders_estado'),
  ('orders.view_etiqueta_impresa', 'orders_estado'),
  ('orders.view_armado', 'orders_estado'),
  ('orders.view_enviado', 'orders_estado'),
  ('orders.view_en_calle', 'orders_estado'),
  ('orders.view_retirado', 'orders_estado'),

  -- Receipts (general)
  ('receipts.view', 'receipts'),
  ('receipts.download', 'receipts'),
  ('receipts.upload_manual', 'receipts'),
  ('receipts.confirm', 'receipts'),
  ('receipts.reject', 'receipts'),

  -- Receipts por estado
  ('receipts.view_pendiente', 'receipts_estado'),
  ('receipts.view_a_confirmar', 'receipts_estado'),
  ('receipts.view_parcial', 'receipts_estado'),
  ('receipts.view_total', 'receipts_estado'),
  ('receipts.view_rechazado', 'receipts_estado'),

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

-- OPERADOR: dashboard + orders + receipts (excepto upload_manual) + todos los estados
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
    -- Estados de pago (orders)
    'orders.view_pendiente',
    'orders.view_a_confirmar',
    'orders.view_parcial',
    'orders.view_total',
    'orders.view_rechazado',
    -- Estados de pedido
    'orders.view_pendiente_pago',
    'orders.view_a_imprimir',
    'orders.view_etiqueta_impresa',
    'orders.view_armado',
    'orders.view_enviado',
    'orders.view_en_calle',
    'orders.view_retirado',
    'receipts.view',
    'receipts.download',
    'receipts.confirm',
    'receipts.reject',
    -- Estados de comprobantes
    'receipts.view_pendiente',
    'receipts.view_a_confirmar',
    'receipts.view_parcial',
    'receipts.view_total',
    'receipts.view_rechazado'
  )
ON CONFLICT DO NOTHING;

-- CAJA: dashboard + receipts + orders.create_cash_payment + estados de pago
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'caja'
  AND p.key IN (
    'dashboard.view',
    'orders.view',
    'orders.create_cash_payment',
    -- Estados de pago (orders) - solo pendiente y a_confirmar
    'orders.view_pendiente',
    'orders.view_a_confirmar',
    -- Estado de pedido - solo pendiente_pago
    'orders.view_pendiente_pago',
    'receipts.view',
    'receipts.download',
    'receipts.confirm',
    'receipts.reject',
    -- Estados de comprobantes - todos para confirmar/rechazar
    'receipts.view_pendiente',
    'receipts.view_a_confirmar',
    'receipts.view_parcial',
    'receipts.view_total',
    'receipts.view_rechazado'
  )
ON CONFLICT DO NOTHING;

-- LOGISTICA: dashboard + orders (view, print, update_status) + estados logísticos
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'logistica'
  AND p.key IN (
    'dashboard.view',
    'orders.view',
    'orders.print',
    'orders.update_status',
    -- Estados de pago - solo los que ya pagaron
    'orders.view_a_confirmar',
    'orders.view_parcial',
    'orders.view_total',
    -- Estados de pedido - todos los logísticos
    'orders.view_a_imprimir',
    'orders.view_etiqueta_impresa',
    'orders.view_armado',
    'orders.view_enviado',
    'orders.view_en_calle',
    'orders.view_retirado'
  )
ON CONFLICT DO NOTHING;

-- READONLY: solo view + todos los estados (lectura)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'readonly'
  AND p.key IN (
    'dashboard.view',
    'orders.view',
    -- Todos los estados de pago
    'orders.view_pendiente',
    'orders.view_a_confirmar',
    'orders.view_parcial',
    'orders.view_total',
    'orders.view_rechazado',
    -- Todos los estados de pedido
    'orders.view_pendiente_pago',
    'orders.view_a_imprimir',
    'orders.view_etiqueta_impresa',
    'orders.view_armado',
    'orders.view_enviado',
    'orders.view_en_calle',
    'orders.view_retirado',
    'receipts.view',
    -- Todos los estados de comprobantes
    'receipts.view_pendiente',
    'receipts.view_a_confirmar',
    'receipts.view_parcial',
    'receipts.view_total',
    'receipts.view_rechazado'
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
  '$2b$10$EROVCB6u3MXY0dMayQltWuSjthXPveoDwg5sJlnjXjY40unWDztru',
  r.id,
  true
FROM roles r
WHERE r.name = 'admin'
ON CONFLICT (email) DO NOTHING;
