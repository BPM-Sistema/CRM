-- Fase 1 PR 5/5 (final): CHECK constraints en orders_validated.
--
-- Red de seguridad a nivel base de datos. Las invariantes ya están defendidas
-- por la app (validaciones HTTP en endpoints PATCH y triggers automáticos en
-- recalcularPagos.js / shipping-data), pero la app puede tener bugs futuros.
-- Estos constraints garantizan que la DB rechace operaciones inválidas
-- independientemente del código.
--
-- Constraint A: lista de valores permitidos para estado_pedido.
--   - Garantiza que typos / valores legacy no migrados / scripts manuales con
--     valores inválidos sean rechazados.
--
-- Constraint B: combinaciones imposibles entre estado_pedido y estado_pago.
--   - SOLO aplica a los estados nuevos `pendiente_retiro` y `por_enviar`.
--   - NO incluye `enviado/en_calle/retirado` porque hay 34 pedidos legítimos
--     con esos estados + pago no confirmado (caso real de pago anulado
--     post-envío por borrado de comprobante o chargeback). Decisión "opción A"
--     tomada con el usuario en el plan de Fase 1.
--
-- Pre-vuelo verificado (2026-05-07): 0 pedidos fuera de la lista, 0 con
-- combinaciones imposibles entre los nuevos estados, 0 con estado_pedido NULL.
--
-- Idempotente: DROP + ADD para reaplicar limpio.
-- Rollback en migrations/rollback/090_rollback.sql (DROP de los dos).

BEGIN;

-- Constraint A: lista de estados válidos.
ALTER TABLE orders_validated
  DROP CONSTRAINT IF EXISTS chk_estado_pedido;
ALTER TABLE orders_validated
  ADD CONSTRAINT chk_estado_pedido CHECK (
    estado_pedido IN (
      'pendiente_pago','a_imprimir','hoja_impresa',
      'en_preparacion','en_revision','pendiente_stock','por_empaquetar',
      'empaquetado',
      'pendiente_retiro','pendiente_datos_envio','por_enviar',
      'en_calle','enviado','retirado','cancelado'
    )
  );

-- Constraint B: combinaciones imposibles para estados nuevos del flujo del depo.
-- Los terminales (enviado/en_calle/retirado) NO se incluyen — ver comentario arriba.
ALTER TABLE orders_validated
  DROP CONSTRAINT IF EXISTS chk_pago_consistente;
ALTER TABLE orders_validated
  ADD CONSTRAINT chk_pago_consistente CHECK (
    NOT (
      estado_pedido IN ('pendiente_retiro','por_enviar')
      AND estado_pago NOT IN ('confirmado_total','a_favor')
    )
  );

COMMIT;
