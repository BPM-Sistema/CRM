-- Fase 1 PR 4: 4 permisos agrupados nuevos para los estados del flujo del depo.
-- Idempotente.
--
-- Objetivo: en lugar de seguir agregando permisos sueltos por cada estado nuevo,
-- consolidamos los 7 estados nuevos bajo 4 permisos lógicos:
--   orders.view_preparacion       → en_preparacion, en_revision, pendiente_stock, por_empaquetar
--   orders.view_empaquetado       → empaquetado
--   orders.view_listos_para_salir → pendiente_retiro, pendiente_datos_envio, por_enviar
--   orders.view_finalizados       → enviado, retirado
--
-- Compatibilidad: los 8 permisos viejos (orders.view_armado, orders.view_retirado, etc.)
-- SE MANTIENEN en la tabla — algunos códigos legacy podrían referenciarlos.
--
-- Asignación a roles: cualquier rol que ya tenga un orders.view_* viejo recibe
-- los 4 nuevos. Garantía: nadie pierde acceso, todos los que veían algo de
-- pedidos antes siguen viendo lo mismo + posiblemente más (los estados nuevos
-- que en Fase 1 todavía no se transitan).
--
-- Rollback: ver migrations/rollback/088_rollback.sql

BEGIN;

-- 1. Crear los 4 permisos nuevos
INSERT INTO permissions (key, module) VALUES
  ('orders.view_preparacion',       'orders_estado'),
  ('orders.view_empaquetado',       'orders_estado'),
  ('orders.view_listos_para_salir', 'orders_estado'),
  ('orders.view_finalizados',       'orders_estado')
ON CONFLICT (key) DO NOTHING;

-- 2. A cada rol que ya tenga al menos un permiso 'orders.view_<estado>' viejo,
-- asignarle los 4 nuevos. Usamos el patrón LIKE 'orders.view_%' para detectar
-- los permisos por estado (no captura otros como orders.update_status).
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p_new.id
FROM role_permissions rp
JOIN permissions p_old ON p_old.id = rp.permission_id
CROSS JOIN permissions p_new
WHERE p_old.key LIKE 'orders.view_%'
  AND p_old.key NOT IN (
    'orders.view_preparacion','orders.view_empaquetado',
    'orders.view_listos_para_salir','orders.view_finalizados'
  )
  AND p_new.key IN (
    'orders.view_preparacion','orders.view_empaquetado',
    'orders.view_listos_para_salir','orders.view_finalizados'
  )
ON CONFLICT DO NOTHING;

COMMIT;
