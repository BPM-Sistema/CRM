-- Rollback de 088_permisos_estados_agrupados.sql
-- Ejecutar SOLO si se revirtió el código del PR 4 y los permisos nuevos
-- están en uso en role_permissions.

BEGIN;

-- 1. Quitar asignaciones role↔permiso para los 4 nuevos.
DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions
  WHERE key IN (
    'orders.view_preparacion','orders.view_empaquetado',
    'orders.view_listos_para_salir','orders.view_finalizados'
  )
);

-- 2. Borrar los permisos nuevos.
DELETE FROM permissions
WHERE key IN (
  'orders.view_preparacion','orders.view_empaquetado',
  'orders.view_listos_para_salir','orders.view_finalizados'
);

COMMIT;
