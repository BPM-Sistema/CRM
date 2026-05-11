-- =====================================================
-- Migración 096: tabla warehouse_stock_issues (Fase 2 PR 4.5)
--
-- Registra los productos faltantes cuando el depo pasa un pedido a
-- pendiente_stock desde el QR. Se selecciona uno o más productos del
-- pedido + cantidad faltante por producto.
--
-- Ciclo de vida del issue:
--   - Se abre cuando el depo pasa a pendiente_stock (uno por producto).
--   - Se cierra automáticamente cuando el pedido sale de pendiente_stock
--     (resolved_at = NOW(), resolved_by_user_id = NULL).
--   - O se cierra manualmente desde el panel del depo (PR 7), con el
--     user_id del admin que lo cerró.
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS warehouse_stock_issues (
  id                              BIGSERIAL PRIMARY KEY,
  order_number                    TEXT NOT NULL,
  -- FK al item de order_products. Si el producto se borra del pedido
  -- por algún motivo, queda en NULL pero conservamos el snapshot.
  order_product_id                INTEGER REFERENCES order_products(id) ON DELETE SET NULL,
  -- Snapshot del producto al momento del reporte (sobrevive aunque el
  -- producto cambie nombre o variant después).
  product_name                    TEXT NOT NULL,
  variant                         TEXT,
  sku                             TEXT,
  quantity_missing                INTEGER NOT NULL CHECK (quantity_missing >= 1),
  -- Quién reportó (empleado del depo desde QR).
  reported_by_warehouse_user_id   INTEGER REFERENCES warehouse_users(id) ON DELETE SET NULL,
  -- Resolución.
  resolved_at                     TIMESTAMPTZ,
  -- user_id del admin (FK a users del CRM si lo cierran manualmente).
  -- NULL cuando se resuelve automáticamente al salir de pendiente_stock.
  -- users.id es UUID en el schema del CRM.
  resolved_by_user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warehouse_stock_issues_order
  ON warehouse_stock_issues (order_number);

-- Index parcial: solo los issues ABIERTOS (resolved_at IS NULL).
-- Optimiza el panel del depo y el auto-resolve.
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_issues_open
  ON warehouse_stock_issues (order_number) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_warehouse_stock_issues_created
  ON warehouse_stock_issues (created_at DESC);

COMMIT;
