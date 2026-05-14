-- Rollback de 100_chk_pago_retiro_parcial.sql
-- Restaura la regla original de 090: pendiente_retiro y por_enviar exigen
-- pago total / a_favor.
--
-- Nota: si hay pedidos en pendiente_retiro con confirmado_parcial al momento
-- del rollback, el ADD CONSTRAINT falla. Resolverlos manualmente antes.

BEGIN;

ALTER TABLE orders_validated
  DROP CONSTRAINT IF EXISTS chk_pago_consistente;

ALTER TABLE orders_validated
  ADD CONSTRAINT chk_pago_consistente CHECK (
    NOT (
      estado_pedido IN ('pendiente_retiro', 'por_enviar')
      AND estado_pago NOT IN ('confirmado_total', 'a_favor')
    )
  );

COMMIT;
