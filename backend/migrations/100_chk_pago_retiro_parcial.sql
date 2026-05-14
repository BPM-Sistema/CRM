-- 2026-05-14: ajustar chk_pago_consistente para aceptar pago parcial en retiro.
--
-- Cambio de regla de negocio:
--   - pendiente_retiro: acepta confirmado_parcial / confirmado_total / a_favor.
--     Razon: el cliente puede señar y pagar el saldo en efectivo al retirar.
--     El local revisa el pago total antes de entregar; si falta saldo, lo cobra
--     en efectivo en ese momento y recien ahi marca 'retirado' (que sigue
--     exigiendo pago total via app + constraint sigue sin contemplar retirado).
--   - por_enviar: sigue exigiendo confirmado_total / a_favor (envio no sale
--     sin pago completo).
--
-- Reemplaza el constraint de migration 090 (que exigia total para ambos).
--
-- Pre-vuelo verificado 2026-05-14: ningun pedido en pendiente_retiro tiene
-- estado_pago fuera de PAGOS_OK_PARCIAL (la regla nueva es mas laxa, no rompe
-- nada que el constraint viejo aceptaba).
--
-- Idempotente: DROP + ADD para reaplicar limpio.
-- Rollback en migrations/rollback/100_rollback.sql (vuelve a la regla 090).

BEGIN;

ALTER TABLE orders_validated
  DROP CONSTRAINT IF EXISTS chk_pago_consistente;

ALTER TABLE orders_validated
  ADD CONSTRAINT chk_pago_consistente CHECK (
    NOT (
      estado_pedido = 'por_enviar'
      AND estado_pago NOT IN ('confirmado_total', 'a_favor')
    )
    AND NOT (
      estado_pedido = 'pendiente_retiro'
      AND estado_pago NOT IN ('confirmado_parcial', 'confirmado_total', 'a_favor')
    )
  );

COMMIT;
