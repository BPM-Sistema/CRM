-- 074: UNIQUE(order_number) + data_updated_at en shipping_requests
--
-- Motivacion: hasta ahora POST /shipping-data hacia DELETE+INSERT cada vez que
-- el cliente reenviaba el formulario /envio. Eso destruia label_printed_at,
-- label_bultos y reprints_count, asi que el siguiente batch de etiquetas
-- imprimia de nuevo silenciosamente con reprints_count=0. Bug observado el
-- 2026-04-29 (pedidos 31518, 31721, 31489 reimpresos sin aviso).
--
-- Fix: pasar a UPSERT in-place preservando estado de impresion. Para detectar
-- cambios post-impresion, agregamos data_updated_at: se mueve solo cuando
-- algun campo critico cambia (NO con email/comentarios). Si
-- data_updated_at > label_printed_at, la UI alerta y exige reimpresion manual.

-- 1. Defensa: deduplicar antes de agregar UNIQUE (no deberia haber, validado
--    en prod 2026-04-29: 658 rows = 658 pedidos). Si por race condition
--    aparece un duplicado, conservamos el row mas reciente.
DELETE FROM shipping_requests sr1
USING shipping_requests sr2
WHERE sr1.order_number = sr2.order_number
  AND sr1.id <> sr2.id
  AND (sr1.created_at, sr1.id::text) < (sr2.created_at, sr2.id::text);

-- 2. UNIQUE en order_number (idempotente con DO block).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shipping_requests_order_number_unique'
  ) THEN
    ALTER TABLE shipping_requests
      ADD CONSTRAINT shipping_requests_order_number_unique UNIQUE (order_number);
  END IF;
END $$;

-- 3. data_updated_at: timestamp de ultima modificacion de datos criticos.
ALTER TABLE shipping_requests
  ADD COLUMN IF NOT EXISTS data_updated_at TIMESTAMPTZ;

-- Backfill: registros existentes empiezan con data_updated_at = created_at
-- (no hay forma de saber cuando se modificaron antes de este fix).
UPDATE shipping_requests
SET data_updated_at = created_at
WHERE data_updated_at IS NULL;

-- Default y NOT NULL para que futuros INSERT siempre tengan valor.
ALTER TABLE shipping_requests
  ALTER COLUMN data_updated_at SET DEFAULT NOW(),
  ALTER COLUMN data_updated_at SET NOT NULL;

-- Indice para el matching de remitos (services/shippingDocuments.js usa
-- data_updated_at > NOW() - 60 days y ORDER BY data_updated_at DESC).
CREATE INDEX IF NOT EXISTS idx_shipping_requests_data_updated
  ON shipping_requests(data_updated_at DESC);
