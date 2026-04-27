-- 066: reprints_count en shipping_requests
-- Motivación: hasta hoy `label_bultos` se usaba para dos cosas distintas:
--   1) cantidad de bultos físicos del paquete (lo que va en la etiqueta).
--   2) contador implícito de cuántas veces se reimprimió la etiqueta
--      (porque el UPDATE hacía `label_bultos = COALESCE(label_bultos,0) + $1`).
-- El resultado en la UI era engañoso: un pedido de 1 bulto reimpreso 9 veces
-- aparecía como "Etiqueta impresa (9 hojas)".
--
-- Fix: separar las dos cosas.
--   - `label_bultos` pasa a representar SOLO la cantidad real de bultos
--     (los UPDATE pasan a usar `= $1` en vez de `+ $1`).
--   - `reprints_count` cuenta cuántas veces se reimprimió.
--
-- Para preservar al menos un dato histórico aproximado de actividad, los
-- registros existentes con `label_bultos > 0` arrancan con
-- `reprints_count = label_bultos - 1` (asumiendo que la primera impresión
-- contribuyó al menos 1 al contador). No es exacto pero da una pista.

ALTER TABLE shipping_requests
  ADD COLUMN IF NOT EXISTS reprints_count INTEGER NOT NULL DEFAULT 0;

-- Backfill aproximado: si un registro ya está impreso y label_bultos > 1,
-- atribuir el exceso a re-impresiones. Casos donde label_bultos = 1 quedan
-- en reprints_count = 0 (impresión inicial, sin re-impresiones contables).
UPDATE shipping_requests
SET reprints_count = GREATEST(label_bultos - 1, 0)
WHERE label_printed_at IS NOT NULL
  AND reprints_count = 0
  AND label_bultos > 1;
