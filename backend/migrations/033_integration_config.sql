-- =====================================================
-- Migración 033: Integration Config (Feature Flags)
-- Sistema de toggles para habilitar/deshabilitar integraciones
-- =====================================================

-- 1. Tabla de configuración de integraciones
CREATE TABLE IF NOT EXISTS integration_config (
  key VARCHAR(100) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  category VARCHAR(50) DEFAULT 'general',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES users(id)
);

-- 2. Índice para búsquedas por categoría
CREATE INDEX IF NOT EXISTS idx_integration_config_category ON integration_config(category);

-- 3. Tabla de auditoría de cambios
CREATE TABLE IF NOT EXISTS integration_config_log (
  id SERIAL PRIMARY KEY,
  config_key VARCHAR(100) NOT NULL,
  old_value BOOLEAN,
  new_value BOOLEAN NOT NULL,
  changed_by UUID REFERENCES users(id),
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  reason TEXT
);

-- 4. Índices para auditoría
CREATE INDEX IF NOT EXISTS idx_integration_config_log_key ON integration_config_log(config_key);
CREATE INDEX IF NOT EXISTS idx_integration_config_log_date ON integration_config_log(changed_at DESC);

-- 5. Insertar configuraciones iniciales de Tiendanube
INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('tiendanube_master_enabled', true, 'Switch maestro - Si está apagado, TODA la integración con Tiendanube queda desactivada', 'tiendanube'),
  ('tiendanube_webhooks_enabled', true, 'Recibir webhooks de Tiendanube (order/created, order/updated, order/cancelled)', 'tiendanube'),
  ('tiendanube_validate_orders', true, 'Validar pedidos contra Tiendanube al subir comprobantes', 'tiendanube'),
  ('tiendanube_fulfillment_labels', true, 'Obtener etiquetas de Envío Nube desde Tiendanube', 'tiendanube'),
  ('tiendanube_sync_orders', true, 'Sincronización automática de pedidos faltantes (polling cada 5 min)', 'tiendanube'),
  ('tiendanube_sync_images', true, 'Sincronización automática de imágenes de productos (cada 5 hrs)', 'tiendanube')
ON CONFLICT (key) DO NOTHING;

-- 6. Permisos RBAC
INSERT INTO permissions (key, module) VALUES
  ('integrations.view', 'admin'),
  ('integrations.update', 'admin')
ON CONFLICT (key) DO NOTHING;

-- 7. Asignar permisos al rol admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.key IN ('integrations.view', 'integrations.update')
ON CONFLICT DO NOTHING;

-- 8. Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_integration_config_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 9. Trigger para updated_at
DROP TRIGGER IF EXISTS trigger_integration_config_updated ON integration_config;
CREATE TRIGGER trigger_integration_config_updated
  BEFORE UPDATE ON integration_config
  FOR EACH ROW
  EXECUTE FUNCTION update_integration_config_timestamp();

-- 10. Función para loguear cambios
CREATE OR REPLACE FUNCTION log_integration_config_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.enabled IS DISTINCT FROM NEW.enabled THEN
    INSERT INTO integration_config_log (config_key, old_value, new_value, changed_by)
    VALUES (NEW.key, OLD.enabled, NEW.enabled, NEW.updated_by);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 11. Trigger para auditoría
DROP TRIGGER IF EXISTS trigger_integration_config_log ON integration_config;
CREATE TRIGGER trigger_integration_config_log
  AFTER UPDATE ON integration_config
  FOR EACH ROW
  EXECUTE FUNCTION log_integration_config_change();
