-- Add matched_by and matched_at columns to bank_movements
-- and support 'matched' as a new assignment_status value

ALTER TABLE bank_movements ADD COLUMN IF NOT EXISTS matched_by VARCHAR(50);
ALTER TABLE bank_movements ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;

-- Index for matching lookups: unassigned movements by amount
CREATE INDEX IF NOT EXISTS idx_bank_movements_unassigned_amount
ON bank_movements (amount, posted_at)
WHERE assignment_status = 'unassigned' AND is_incoming = true;
