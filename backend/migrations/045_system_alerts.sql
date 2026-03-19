-- =====================================================
-- Migración 045: Sistema de alertas internas
-- Permite persistir y visualizar alertas operativas
-- sin depender de webhooks externos
-- =====================================================

CREATE TABLE IF NOT EXISTS system_alerts (
  id SERIAL PRIMARY KEY,
  level VARCHAR(20) NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  category VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  service VARCHAR(50),
  metadata JSONB DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by UUID REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_alerts_status ON system_alerts(status);
CREATE INDEX IF NOT EXISTS idx_system_alerts_level ON system_alerts(level);
CREATE INDEX IF NOT EXISTS idx_system_alerts_created ON system_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_alerts_category ON system_alerts(category);

-- Permisos RBAC
INSERT INTO permissions (key, module) VALUES
  ('system_alerts.view', 'admin'),
  ('system_alerts.manage', 'admin')
ON CONFLICT (key) DO NOTHING;

-- Asignar permisos al rol admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'admin'
  AND p.key IN ('system_alerts.view', 'system_alerts.manage')
ON CONFLICT DO NOTHING;
