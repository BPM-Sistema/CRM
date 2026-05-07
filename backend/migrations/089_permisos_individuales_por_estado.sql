-- Fase 1 PR 4 (revisión): permisos individuales por estado en lugar de agrupados.
--
-- Cambio de criterio respecto al PR 4: en vez de 4 permisos agrupados que cubren
-- varios estados, hacemos 1 permiso por cada estado (15 en total). Garantiza
-- simetría 1↔1 entre los botones de filtro y los checkboxes de RBAC.
--
-- Esta migration:
--   1. Crea 7 permisos individuales nuevos (los del flujo del depo + 3 estados
--      de espera).
--   2. Migra role_permissions: cualquier rol que tenga un permiso agrupado del
--      PR 4 (preparacion / listos_para_salir / finalizados) recibe los
--      individuales correspondientes.
--   3. Cualquier rol con orders.view_armado (legacy del rename de PR 2) recibe
--      orders.view_empaquetado (mismo estado, nombre nuevo).
--   4. Elimina los 4 permisos que pasan a ser redundantes: preparacion,
--      listos_para_salir, finalizados, y armado (legacy).
--
-- Idempotente: ON CONFLICT DO NOTHING en INSERTs y los DELETEs no fallan si la
-- fila ya no existe.
--
-- Rollback en migrations/rollback/089_rollback.sql.

BEGIN;

-- 1. Crear los 7 permisos individuales nuevos.
INSERT INTO permissions (key, module) VALUES
  ('orders.view_en_preparacion',        'orders_estado'),
  ('orders.view_en_revision',           'orders_estado'),
  ('orders.view_pendiente_stock',       'orders_estado'),
  ('orders.view_por_empaquetar',        'orders_estado'),
  ('orders.view_pendiente_datos_envio', 'orders_estado'),
  ('orders.view_pendiente_retiro',      'orders_estado'),
  ('orders.view_por_enviar',            'orders_estado')
ON CONFLICT (key) DO NOTHING;

-- 2. Migrar agrupados → individuales:
-- 2a. Roles con orders.view_preparacion → reciben los 4 individuales del depo.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_new.id
FROM role_permissions rp
JOIN permissions p_old ON p_old.id = rp.permission_id
CROSS JOIN permissions p_new
WHERE p_old.key = 'orders.view_preparacion'
  AND p_new.key IN (
    'orders.view_en_preparacion','orders.view_en_revision',
    'orders.view_pendiente_stock','orders.view_por_empaquetar'
  )
ON CONFLICT DO NOTHING;

-- 2b. Roles con orders.view_listos_para_salir → reciben los 3 individuales.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_new.id
FROM role_permissions rp
JOIN permissions p_old ON p_old.id = rp.permission_id
CROSS JOIN permissions p_new
WHERE p_old.key = 'orders.view_listos_para_salir'
  AND p_new.key IN (
    'orders.view_pendiente_datos_envio','orders.view_pendiente_retiro','orders.view_por_enviar'
  )
ON CONFLICT DO NOTHING;

-- 2c. Roles con orders.view_finalizados → reciben enviado + retirado (existentes).
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_new.id
FROM role_permissions rp
JOIN permissions p_old ON p_old.id = rp.permission_id
CROSS JOIN permissions p_new
WHERE p_old.key = 'orders.view_finalizados'
  AND p_new.key IN ('orders.view_enviado','orders.view_retirado')
ON CONFLICT DO NOTHING;

-- 2d. Roles con orders.view_armado (legacy) → reciben orders.view_empaquetado.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_new.id
FROM role_permissions rp
JOIN permissions p_old ON p_old.id = rp.permission_id
CROSS JOIN permissions p_new
WHERE p_old.key = 'orders.view_armado'
  AND p_new.key = 'orders.view_empaquetado'
ON CONFLICT DO NOTHING;

-- 3. Eliminar role_permissions de los 4 permisos a remover.
DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions
  WHERE key IN (
    'orders.view_preparacion','orders.view_listos_para_salir',
    'orders.view_finalizados','orders.view_armado'
  )
);

-- 4. Eliminar los 4 permisos.
DELETE FROM permissions
WHERE key IN (
  'orders.view_preparacion','orders.view_listos_para_salir',
  'orders.view_finalizados','orders.view_armado'
);

COMMIT;
