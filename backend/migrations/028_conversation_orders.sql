-- Create conversation_orders table for manual chat-order associations
CREATE TABLE IF NOT EXISTS conversation_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_orders_unique
  ON conversation_orders(conversation_id, order_number);
CREATE INDEX IF NOT EXISTS idx_conversation_orders_conversation
  ON conversation_orders(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_orders_order
  ON conversation_orders(order_number);
