-- =====================================================
-- BANK MOVEMENTS IGNORED - Blocklist por movement_uid
-- Movimientos bancarios que deben excluirse del panel
-- admin bancario y nunca re-importarse.
-- =====================================================

CREATE TABLE IF NOT EXISTS bank_movements_ignored (
  movement_uid TEXT PRIMARY KEY,
  reason TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_movements_ignored_created_at
  ON bank_movements_ignored(created_at DESC);
