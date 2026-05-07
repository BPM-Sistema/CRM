-- Rollback de 089_permisos_individuales_por_estado.sql
-- Recrea los 4 permisos agrupados que se borraron y restaura las asignaciones
-- aproximadamente (no preservamos qué rol tenía cada agrupado, asignamos a los
-- mismos roles que tienen los individuales correspondientes).

BEGIN;

-- 1. Recrear los 4 permisos eliminados.
INSERT INTO permissions (key, module) VALUES
  ('orders.view_preparacion',       'orders_estado'),
  ('orders.view_empaquetado',       'orders_estado'),  -- Permanece (era individual también).
  ('orders.view_listos_para_salir', 'orders_estado'),
  ('orders.view_finalizados',       'orders_estado'),
  ('orders.view_armado',            'orders_estado')   -- Legacy.
ON CONFLICT (key) DO NOTHING;

-- 2. Re-asignar agrupados a roles que ya tienen los individuales:
-- 2a. Roles con todos los 4 individuales del depo → asignar orders.view_preparacion.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p_grp.id
FROM role_permissions rp
JOIN permissions p_grp ON p_grp.key = 'orders.view_preparacion'
JOIN permissions p_ind ON p_ind.id = rp.permission_id
WHERE p_ind.key IN (
  'orders.view_en_preparacion','orders.view_en_revision',
  'orders.view_pendiente_stock','orders.view_por_empaquetar'
)
GROUP BY rp.role_id, p_grp.id
HAVING COUNT(*) = 4
ON CONFLICT DO NOTHING;

-- 2b. Roles con todos los 3 individuales de listos → asignar orders.view_listos_para_salir.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p_grp.id
FROM role_permissions rp
JOIN permissions p_grp ON p_grp.key = 'orders.view_listos_para_salir'
JOIN permissions p_ind ON p_ind.id = rp.permission_id
WHERE p_ind.key IN (
  'orders.view_pendiente_datos_envio','orders.view_pendiente_retiro','orders.view_por_enviar'
)
GROUP BY rp.role_id, p_grp.id
HAVING COUNT(*) = 3
ON CONFLICT DO NOTHING;

-- 2c. Roles con enviado + retirado → asignar orders.view_finalizados.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p_grp.id
FROM role_permissions rp
JOIN permissions p_grp ON p_grp.key = 'orders.view_finalizados'
JOIN permissions p_ind ON p_ind.id = rp.permission_id
WHERE p_ind.key IN ('orders.view_enviado','orders.view_retirado')
GROUP BY rp.role_id, p_grp.id
HAVING COUNT(*) = 2
ON CONFLICT DO NOTHING;

-- 2d. Roles con orders.view_empaquetado → asignar también orders.view_armado (legacy).
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_old.id
FROM role_permissions rp
JOIN permissions p_emp ON p_emp.id = rp.permission_id
CROSS JOIN permissions p_old
WHERE p_emp.key = 'orders.view_empaquetado'
  AND p_old.key = 'orders.view_armado'
ON CONFLICT DO NOTHING;

-- 3. Eliminar role_permissions de los 7 individuales nuevos.
DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions
  WHERE key IN (
    'orders.view_en_preparacion','orders.view_en_revision',
    'orders.view_pendiente_stock','orders.view_por_empaquetar',
    'orders.view_pendiente_datos_envio','orders.view_pendiente_retiro',
    'orders.view_por_enviar'
  )
);

-- 4. Borrar los 7 permisos individuales nuevos.
DELETE FROM permissions
WHERE key IN (
  'orders.view_en_preparacion','orders.view_en_revision',
  'orders.view_pendiente_stock','orders.view_por_empaquetar',
  'orders.view_pendiente_datos_envio','orders.view_pendiente_retiro',
  'orders.view_por_enviar'
);

COMMIT;
