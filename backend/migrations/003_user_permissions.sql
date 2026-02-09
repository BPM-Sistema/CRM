-- =====================================================
-- USER PERMISSIONS MIGRATION
-- Permisos directos por usuario (sin roles intermedios)
-- =====================================================

-- Tabla de permisos directos por usuario
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, permission_id)
);

-- Indice para performance
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);

-- Migrar permisos existentes de roles a usuarios
-- Copia los permisos que cada usuario tiene via su rol actual
INSERT INTO user_permissions (user_id, permission_id)
SELECT u.id, rp.permission_id
FROM users u
JOIN role_permissions rp ON u.role_id = rp.role_id
WHERE u.role_id IS NOT NULL
ON CONFLICT DO NOTHING;
