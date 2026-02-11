-- =====================================================
-- ACTIVITY LOG - Migración para historial de actividad
-- =====================================================

-- 1. Agregar columnas a logs si no existen
ALTER TABLE logs ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE logs ADD COLUMN IF NOT EXISTS username VARCHAR(255);
ALTER TABLE logs ADD COLUMN IF NOT EXISTS order_number VARCHAR(100);

-- 2. Índices para filtros rápidos
CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_order_number ON logs(order_number);
CREATE INDEX IF NOT EXISTS idx_logs_accion ON logs(accion);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);

-- 3. Agregar permiso activity.view
INSERT INTO permissions (key, module) VALUES
  ('activity.view', 'activity')
ON CONFLICT (key) DO NOTHING;

-- 4. Asignar permiso solo a admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'activity.view'
ON CONFLICT DO NOTHING;
