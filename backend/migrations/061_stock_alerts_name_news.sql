-- =====================================================
-- STOCK ALERTS — campos first_name y wants_news (opt-in novedades)
-- =====================================================

ALTER TABLE stock_alerts
  ADD COLUMN IF NOT EXISTS first_name TEXT;

ALTER TABLE stock_alerts
  ADD COLUMN IF NOT EXISTS wants_news BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_stock_alerts_wants_news
  ON stock_alerts(wants_news) WHERE wants_news = TRUE;
