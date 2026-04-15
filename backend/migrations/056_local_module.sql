-- =====================================================
-- MÓDULO LOCAL — Tablas, permisos, roles
-- =====================================================

-- =====================================================
-- 1. TABLA: local_orders (Reservas depósito ↔ local)
-- =====================================================
CREATE TABLE IF NOT EXISTS local_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_order_number SERIAL,
  status VARCHAR(30) NOT NULL DEFAULT 'reservado',
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_by_role VARCHAR(50),
  notes_internal TEXT,
  print_count INTEGER DEFAULT 0,
  last_printed_by UUID REFERENCES users(id),
  last_edited_by UUID REFERENCES users(id),
  printed_at TIMESTAMPTZ,
  packed_at TIMESTAMPTZ,
  shipped_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_orders_status ON local_orders(status);
CREATE INDEX IF NOT EXISTS idx_local_orders_created_at ON local_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_orders_number ON local_orders(local_order_number);

-- =====================================================
-- 2. TABLA: local_order_items (Líneas de reserva)
-- =====================================================
CREATE TABLE IF NOT EXISTS local_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_order_id UUID NOT NULL REFERENCES local_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  variant_id TEXT,
  sku_snapshot TEXT,
  product_name_snapshot TEXT NOT NULL,
  variant_name_snapshot TEXT,
  reserved_qty INTEGER NOT NULL DEFAULT 0,
  sent_qty INTEGER NOT NULL DEFAULT 0,
  received_qty INTEGER,
  control_status VARCHAR(20) DEFAULT 'pendiente',
  control_checked_at TIMESTAMPTZ,
  control_checked_by UUID REFERENCES users(id),
  line_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_order_items_order ON local_order_items(local_order_id);
CREATE INDEX IF NOT EXISTS idx_local_order_items_product ON local_order_items(product_id);

-- =====================================================
-- 3. TABLA: local_order_prints (Historial de impresión)
-- =====================================================
CREATE TABLE IF NOT EXISTS local_order_prints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_order_id UUID NOT NULL REFERENCES local_orders(id) ON DELETE CASCADE,
  printed_by UUID NOT NULL REFERENCES users(id),
  printed_at TIMESTAMPTZ DEFAULT NOW(),
  print_version INTEGER NOT NULL DEFAULT 1,
  snapshot_payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_local_order_prints_order ON local_order_prints(local_order_id);

-- =====================================================
-- 4. TABLA: local_stock (Stock asignado al local)
-- =====================================================
CREATE TABLE IF NOT EXISTS local_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id BIGINT NOT NULL,
  variant_id TEXT,
  product_name TEXT NOT NULL,
  variant_name TEXT,
  qty INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_stock_unique ON local_stock(product_id, COALESCE(variant_id, ''));
CREATE INDEX IF NOT EXISTS idx_local_stock_product ON local_stock(product_id);

-- =====================================================
-- 5. TABLA: local_box_orders (Pedidos de caja)
-- =====================================================
CREATE TABLE IF NOT EXISTS local_box_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_box_order_number SERIAL,
  status VARCHAR(30) NOT NULL DEFAULT 'borrador',
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  notes TEXT,
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_status VARCHAR(30) DEFAULT 'pendiente_pago',
  printed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  confirmed_paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_box_orders_status ON local_box_orders(status);
CREATE INDEX IF NOT EXISTS idx_local_box_orders_created_at ON local_box_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_box_orders_payment ON local_box_orders(payment_status);

-- =====================================================
-- 6. TABLA: local_box_order_items (Líneas de caja)
-- =====================================================
CREATE TABLE IF NOT EXISTS local_box_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_box_order_id UUID NOT NULL REFERENCES local_box_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  variant_id TEXT,
  sku_snapshot TEXT,
  product_name_snapshot TEXT NOT NULL,
  variant_name_snapshot TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_local_box_order_items_order ON local_box_order_items(local_box_order_id);

-- =====================================================
-- 7. TABLA: local_logs (Auditoría del módulo)
-- =====================================================
CREATE TABLE IF NOT EXISTS local_logs (
  id BIGSERIAL PRIMARY KEY,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID,
  user_id UUID REFERENCES users(id),
  user_role VARCHAR(50),
  username VARCHAR(255),
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_logs_entity ON local_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_local_logs_action ON local_logs(action);
CREATE INDEX IF NOT EXISTS idx_local_logs_created_at ON local_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_logs_user ON local_logs(user_id);

-- =====================================================
-- 8. PERMISOS DEL MÓDULO LOCAL
-- =====================================================
INSERT INTO permissions (key, module) VALUES
  -- Reservas
  ('local.orders.view', 'local'),
  ('local.orders.create', 'local'),
  ('local.orders.edit', 'local'),
  ('local.orders.print', 'local'),
  ('local.orders.pack', 'local'),
  ('local.orders.ship', 'local'),
  ('local.orders.control', 'local'),
  ('local.orders.confirm', 'local'),
  ('local.orders.cancel', 'local'),
  -- Caja
  ('local.box.view', 'local'),
  ('local.box.create', 'local'),
  ('local.box.edit', 'local'),
  ('local.box.print', 'local'),
  ('local.box.pay', 'local'),
  -- Alertas
  ('local.alerts.view', 'local')
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- 9. ROLES DEL MÓDULO LOCAL
-- =====================================================
INSERT INTO roles (name) VALUES
  ('admin_local'),
  ('admin_deposito')
ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- 10. ASIGNAR PERMISOS A ROLES
-- =====================================================

-- admin_local: crear reserva, ver, controlar, confirmar, caja, alertas
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin_local' AND p.key IN (
  'local.orders.view',
  'local.orders.create',
  'local.orders.control',
  'local.orders.confirm',
  'local.orders.cancel',
  'local.box.view',
  'local.box.create',
  'local.box.edit',
  'local.box.print',
  'local.box.pay',
  'local.alerts.view'
)
ON CONFLICT DO NOTHING;

-- admin_deposito: ver, editar, imprimir, armar, enviar reservas, alertas
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin_deposito' AND p.key IN (
  'local.orders.view',
  'local.orders.edit',
  'local.orders.print',
  'local.orders.pack',
  'local.orders.ship',
  'local.orders.cancel',
  'local.alerts.view'
)
ON CONFLICT DO NOTHING;

-- admin también tiene todos los permisos del módulo local
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.module = 'local'
ON CONFLICT DO NOTHING;
