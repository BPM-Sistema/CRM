-- 105: Tabla para tracking de pedidos de reseñas en Google Maps.
--
-- Cada fila representa un link único enviado a un cliente:
--   - El cliente recibe https://blanqueriaxmayor.com/resena/{token} por WhatsApp.
--   - El endpoint público GET /resena/:token registra el click y redirige a
--     la ficha de Google Maps (https://g.page/r/CUODLKG8ZZm5EBM/review).
--
-- Convención:
--   - sent_at se setea al confirmar OK del envío por Waspy.
--   - clicked_at se setea en el primer click.
--   - click_count se incrementa en CADA click (el cliente puede abrirlo varias veces).
--   - status: 'pending' (creado, sin enviar) | 'sent' (enviado OK) | 'failed' (error Waspy).
--
-- Constraint: 1 link activo por order_number (un pedido no recibe 2 pedidos
-- de reseña). UNIQUE permite re-intentos si el primero quedó en 'failed'.

BEGIN;

CREATE TABLE IF NOT EXISTS review_request_links (
  id              BIGSERIAL PRIMARY KEY,
  order_number    BIGINT NOT NULL,
  customer_phone  TEXT NOT NULL,
  customer_name   TEXT,
  token           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','failed')),
  send_error      TEXT,
  provider_message_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  clicked_at      TIMESTAMPTZ,
  click_count     INTEGER NOT NULL DEFAULT 0
);

-- 1 link 'sent' por pedido — no mandamos 2 veces al mismo cliente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_links_one_sent_per_order
  ON review_request_links (order_number)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_review_links_order_number
  ON review_request_links (order_number);

CREATE INDEX IF NOT EXISTS idx_review_links_sent_at
  ON review_request_links (sent_at DESC) WHERE sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_links_clicked_at
  ON review_request_links (clicked_at DESC) WHERE clicked_at IS NOT NULL;

COMMIT;
