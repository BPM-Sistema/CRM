-- =====================================================
-- BANK IMPORTS & MOVEMENTS - Panel Admin Bancario
-- Tablas para persistir movimientos bancarios importados
-- NO afecta comprobantes ni conciliación existente
-- =====================================================

-- Tabla: historial de archivos importados
CREATE TABLE IF NOT EXISTS bank_imports (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(100) DEFAULT 'manual',
  filename TEXT,
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  raw_payload JSONB,
  status VARCHAR(30) DEFAULT 'completed',
  total_rows INTEGER DEFAULT 0,
  total_incoming INTEGER DEFAULT 0,
  total_inserted INTEGER DEFAULT 0,
  total_duplicated INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_imports_uploaded_at ON bank_imports(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_imports_uploaded_by ON bank_imports(uploaded_by);

-- Tabla: movimientos bancarios individuales persistidos
CREATE TABLE IF NOT EXISTS bank_movements (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT NOT NULL REFERENCES bank_imports(id) ON DELETE CASCADE,
  movement_uid TEXT,
  fingerprint TEXT NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'ARS',
  sender_name TEXT,
  sender_tax_id TEXT,
  sender_account TEXT,
  receiver_name TEXT,
  receiver_account TEXT,
  description TEXT,
  reference TEXT,
  bank_name TEXT,
  raw_row JSONB,
  is_incoming BOOLEAN DEFAULT true,
  assignment_status VARCHAR(20) DEFAULT 'unassigned',
  linked_comprobante_id BIGINT,
  linked_order_number VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deduplicación por fingerprint
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_movements_fingerprint ON bank_movements(fingerprint);

-- Filtros principales
CREATE INDEX IF NOT EXISTS idx_bank_movements_posted_at ON bank_movements(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_movements_amount ON bank_movements(amount);
CREATE INDEX IF NOT EXISTS idx_bank_movements_assignment ON bank_movements(assignment_status);
CREATE INDEX IF NOT EXISTS idx_bank_movements_import_id ON bank_movements(import_id);
CREATE INDEX IF NOT EXISTS idx_bank_movements_linked_comp ON bank_movements(linked_comprobante_id) WHERE linked_comprobante_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_movements_linked_order ON bank_movements(linked_order_number) WHERE linked_order_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_movements_sender ON bank_movements(sender_name);
CREATE INDEX IF NOT EXISTS idx_bank_movements_incoming ON bank_movements(is_incoming, posted_at DESC);

-- Búsqueda libre
CREATE INDEX IF NOT EXISTS idx_bank_movements_movement_uid ON bank_movements(movement_uid) WHERE movement_uid IS NOT NULL;

-- Permiso para el panel admin bancario
INSERT INTO permissions (key, module) VALUES
  ('bank.view', 'bank')
ON CONFLICT (key) DO NOTHING;

-- Asignar a role_permissions (template para nuevos usuarios)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'bank.view'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name IN ('operador', 'caja') AND p.key = 'bank.view'
ON CONFLICT DO NOTHING;

-- Asignar a user_permissions para usuarios EXISTENTES con roles admin/operador/caja
-- (el auth middleware lee de user_permissions, no de role_permissions)
INSERT INTO user_permissions (user_id, permission_id)
SELECT u.id, p.id
FROM users u
JOIN roles r ON u.role_id = r.id
CROSS JOIN permissions p
WHERE r.name IN ('admin', 'operador', 'caja')
  AND p.key = 'bank.view'
  AND u.is_active = true
ON CONFLICT DO NOTHING;
