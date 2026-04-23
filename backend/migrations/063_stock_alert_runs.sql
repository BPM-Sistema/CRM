-- =====================================================
-- STOCK ALERTS — Auditoría de corridas del dispatcher
-- Cada invocación (cron o dry-run) registra una fila con métricas.
-- =====================================================

CREATE TABLE IF NOT EXISTS stock_alert_runs (
  id                  SERIAL PRIMARY KEY,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  trigger_source      TEXT,                 -- 'cron', 'manual', 'dry-run', etc.
  dry_run             BOOLEAN NOT NULL DEFAULT FALSE,
  pairs_checked       INTEGER NOT NULL DEFAULT 0,
  fetched             INTEGER NOT NULL DEFAULT 0,
  fetch_errors        INTEGER NOT NULL DEFAULT 0,
  dispatched_products INTEGER NOT NULL DEFAULT 0,  -- cuántos (product_id, variant_id) tuvieron reposición
  alerts_sent         INTEGER NOT NULL DEFAULT 0,  -- cuántos WhatsApps se encolaron
  alerts_send_errors  INTEGER NOT NULL DEFAULT 0,
  skipped_no_template BOOLEAN NOT NULL DEFAULT FALSE,
  updated_state       INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,                 -- si el run entero cayó
  stats_raw           JSONB                 -- snapshot crudo por si queremos inspeccionar
);

CREATE INDEX IF NOT EXISTS idx_stock_alert_runs_started
  ON stock_alert_runs(started_at DESC);
