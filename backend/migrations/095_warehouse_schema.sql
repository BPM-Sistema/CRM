-- =====================================================
-- Migración 095: schema del depo (Fase 2 PR 3)
--
-- Crea las 3 tablas que después usan PR 4 (página /q/:orderNumber) y
-- PR 7 (panel /deposito), suma la columna bultos en orders_validated y
-- registra los 6 permisos RBAC deposito.*.
--
-- IMPORTANTE: esta migration es SOLO schema. No hay código que use estas
-- tablas todavía. La columna bultos tampoco se lee/escribe desde ningún
-- endpoint hasta PR 4 (que hace pasar el display oficina a leer OV.bultos
-- en lugar de SR.label_bultos).
--
-- Idempotente.
-- =====================================================

BEGIN;

-- ─── 1. Tabla warehouse_users ─────────────────────────────────
-- Empleados del depo. Código 4 dígitos plain text (10.000 combinaciones,
-- hashear no agrega seguridad real — la protección está en el endpoint
-- + permisos del operador). active=false en lugar de DELETE para preservar
-- los logs históricos en warehouse_state_transitions.
CREATE TABLE IF NOT EXISTS warehouse_users (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  codigo      VARCHAR(4) NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_codigo_4digits CHECK (codigo ~ '^[0-9]{4}$')
);

-- Búsqueda por código en login → unique entre activos.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_warehouse_users_codigo_active
  ON warehouse_users (codigo) WHERE active = TRUE;

-- ─── 2. Tabla warehouse_user_permissions ──────────────────────
-- Una fila por (empleado, transición). Diseño limpio para integridad
-- referencial: si se elimina el empleado, ON DELETE CASCADE limpia los
-- permisos. Pero en práctica nunca se elimina, solo se desactiva.
--
-- transicion: nombre de la transición que el empleado puede disparar
-- desde el QR. Valores esperados (validados por la app, no por la DB):
--   'en_preparacion', 'en_revision', 'pendiente_stock', 'por_empaquetar',
--   'empaquetado'. Los demás estados los maneja la oficina.
CREATE TABLE IF NOT EXISTS warehouse_user_permissions (
  id                 SERIAL PRIMARY KEY,
  warehouse_user_id  INTEGER NOT NULL REFERENCES warehouse_users(id) ON DELETE CASCADE,
  transicion         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_user_id, transicion)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_user_permissions_user
  ON warehouse_user_permissions (warehouse_user_id);

-- ─── 3. Tabla warehouse_state_transitions ─────────────────────
-- Log de TODAS las transiciones del depo (vengan del QR o de oficina).
-- Complementa la tabla 'logs' existente del CRM — no la reemplaza. Alimenta
-- el panel /deposito (PR 7) con filtros, métricas y ranking de empleados.
--
-- warehouse_user_id es NULLABLE: cambios de oficina/oficina no tienen
-- empleado del depo asociado. Los del QR sí.
--
-- source: 'qr' | 'oficina' | 'trigger_auto' | 'webhook' — origen del cambio.
-- Permite distinguir qué % de movimientos vienen del QR.
CREATE TABLE IF NOT EXISTS warehouse_state_transitions (
  id                 BIGSERIAL PRIMARY KEY,
  order_number       TEXT NOT NULL,
  from_status        TEXT,
  to_status          TEXT NOT NULL,
  warehouse_user_id  INTEGER REFERENCES warehouse_users(id) ON DELETE SET NULL,
  source             TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warehouse_st_order      ON warehouse_state_transitions (order_number);
CREATE INDEX IF NOT EXISTS idx_warehouse_st_user_date  ON warehouse_state_transitions (warehouse_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_st_created_at ON warehouse_state_transitions (created_at DESC);

-- ─── 4. Columna bultos en orders_validated ────────────────────
-- Pasa a ser la fuente de verdad para "cantidad de bultos del pedido"
-- (Opción B del plan Fase 2). shipping_requests.label_bultos queda intacto
-- — el código viejo de etiqueta de envío sigue leyendo de ahí. PR 4 cambia
-- el display oficina (RealOrderDetail.tsx) para leer OV.bultos.
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS bultos INTEGER;

-- Backfill desde shipping_requests más reciente con label_bultos > 0.
-- Para pedidos sin SR o con label_bultos = 0/NULL → default 1.
UPDATE orders_validated ov
SET bultos = COALESCE(
  (SELECT label_bultos FROM shipping_requests
    WHERE order_number = ov.order_number
      AND label_bultos > 0
    ORDER BY id DESC LIMIT 1),
  1
)
WHERE bultos IS NULL;

-- Una vez backfilleado, fijar NOT NULL + DEFAULT 1.
ALTER TABLE orders_validated ALTER COLUMN bultos SET NOT NULL;
ALTER TABLE orders_validated ALTER COLUMN bultos SET DEFAULT 1;
ALTER TABLE orders_validated ADD CONSTRAINT chk_bultos_positivo
  CHECK (bultos >= 1) NOT VALID;
ALTER TABLE orders_validated VALIDATE CONSTRAINT chk_bultos_positivo;

-- ─── 5. Permisos RBAC deposito.* ──────────────────────────────
-- 6 permisos individuales para granular el acceso al panel del depo (PR 7).
-- Por defecto solo el rol admin los recibe. La oficina puede asignar
-- selectivamente a otros usuarios desde el panel de admin existente.
INSERT INTO permissions (key, module) VALUES
  ('deposito.ver_deposito',         'deposito'),
  ('deposito.gestionar_empleados',  'deposito'),
  ('deposito.ver_actividades',      'deposito'),
  ('deposito.modificar_actividades','deposito'),
  ('deposito.ver_codigos',          'deposito'),
  ('deposito.modificar_codigos',    'deposito')
ON CONFLICT (key) DO NOTHING;

-- Asignar los 6 al rol admin.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.key LIKE 'deposito.%'
ON CONFLICT DO NOTHING;

COMMIT;
