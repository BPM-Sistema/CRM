-- Migration 017: AI Bot Module Tables
-- Idempotent: safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING)

-- ============================================================
-- AI Bot Configuration
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_bot_config (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AI Bot Events (incoming webhooks)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_bot_events (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(255) UNIQUE NOT NULL, -- Meta's event ID for idempotency
  channel VARCHAR(50) NOT NULL, -- 'instagram_comment', 'facebook_comment', 'messenger'
  platform VARCHAR(20) NOT NULL, -- 'instagram', 'facebook'
  event_type VARCHAR(50) NOT NULL, -- 'comment', 'message', 'mention'
  raw_payload JSONB NOT NULL,
  sender_id VARCHAR(255),
  sender_name VARCHAR(255),
  content_text TEXT,
  media_id VARCHAR(255), -- post/media ID
  parent_id VARCHAR(255), -- parent comment if reply
  status VARCHAR(30) DEFAULT 'received', -- received, processing, responded, ignored, failed, skipped
  skip_reason VARCHAR(100), -- 'emoji_only', 'tag_only', 'already_replied', 'spam', 'bot_off'
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_bot_events_status ON ai_bot_events(status);
CREATE INDEX IF NOT EXISTS idx_ai_bot_events_channel ON ai_bot_events(channel);
CREATE INDEX IF NOT EXISTS idx_ai_bot_events_created ON ai_bot_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_bot_events_event_id ON ai_bot_events(event_id);
CREATE INDEX IF NOT EXISTS idx_ai_bot_events_media_id ON ai_bot_events(media_id);

-- ============================================================
-- AI Bot Messages (what the AI generated)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_bot_messages (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES ai_bot_events(id) ON DELETE CASCADE,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  model VARCHAR(100),
  system_prompt_version VARCHAR(50),
  generated_text TEXT NOT NULL,
  confidence DECIMAL(3,2), -- 0.00 to 1.00
  generation_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_bot_messages_event ON ai_bot_messages(event_id);

-- ============================================================
-- AI Bot Replies (what was actually sent to Meta)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_bot_replies (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES ai_bot_events(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES ai_bot_messages(id),
  meta_reply_id VARCHAR(255), -- ID returned by Meta API
  reply_text TEXT NOT NULL,
  channel VARCHAR(50) NOT NULL,
  status VARCHAR(30) DEFAULT 'pending', -- pending, sent, failed, rejected_by_human
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_bot_replies_event ON ai_bot_replies(event_id);
CREATE INDEX IF NOT EXISTS idx_ai_bot_replies_status ON ai_bot_replies(status);

-- ============================================================
-- AI Bot Failures (detailed error tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_bot_failures (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES ai_bot_events(id) ON DELETE SET NULL,
  stage VARCHAR(50) NOT NULL, -- 'webhook_parse', 'ai_generate', 'meta_send', 'rules_engine'
  error_code VARCHAR(100),
  error_message TEXT NOT NULL,
  error_stack TEXT,
  context JSONB,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_bot_failures_stage ON ai_bot_failures(stage);
CREATE INDEX IF NOT EXISTS idx_ai_bot_failures_resolved ON ai_bot_failures(resolved);
CREATE INDEX IF NOT EXISTS idx_ai_bot_failures_created ON ai_bot_failures(created_at DESC);

-- ============================================================
-- AI Bot Metrics (aggregated hourly)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_bot_metrics (
  id SERIAL PRIMARY KEY,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  channel VARCHAR(50),
  events_received INTEGER DEFAULT 0,
  events_processed INTEGER DEFAULT 0,
  events_skipped INTEGER DEFAULT 0,
  events_failed INTEGER DEFAULT 0,
  replies_sent INTEGER DEFAULT 0,
  replies_failed INTEGER DEFAULT 0,
  avg_response_time_ms INTEGER,
  avg_generation_time_ms INTEGER,
  total_prompt_tokens INTEGER DEFAULT 0,
  total_completion_tokens INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(period_start, channel)
);

CREATE INDEX IF NOT EXISTS idx_ai_bot_metrics_period ON ai_bot_metrics(period_start DESC);

-- ============================================================
-- Seed default config values
-- ============================================================
INSERT INTO ai_bot_config (key, value, description) VALUES
  ('global_enabled', 'false', 'Master switch for the AI bot'),
  ('mode', '"suggestion"', 'Operation mode: off, suggestion, automatic'),
  ('channels', '{"instagram_comment": true, "facebook_comment": true, "messenger": true}', 'Enabled channels'),
  ('rate_limits', '{"max_replies_per_minute": 10, "max_replies_per_hour": 200, "max_tokens_per_day": 100000}', 'Rate limits'),
  ('claude_config', '{"model": "claude-sonnet-4-5-20250514", "max_tokens": 150, "temperature": 0.6}', 'Claude API configuration'),
  ('meta_config', '{"verify_token": "", "app_secret": "", "page_id": "219833397890190", "ig_account_id": "17841438982939878"}', 'Meta API configuration'),
  ('system_prompt', '"Sos una vendedora de Blanqueria X Mayor (@blanqueriaxmayorok). Respondés comentarios en Instagram y Facebook.\n\nREGLAS DE TONO:\n- Siempre empezá con \"Holis\" (o \"Holiss\", \"Holi\"). Si el cliente reclama, usá \"Hola\".\n- Sé ultra breve (8-12 palabras máximo por respuesta)\n- Usá voseo argentino informal (mandame, podés, tenés)\n- Emojis: 🙌❤ al final de redirecciones, 🚛 para envíos, 🔥 para celebrar\n- Decí \"Sii\"/\"Siii\" (nunca \"por supuesto\") y \"nop\" (nunca \"lamentablemente no\")\n- NUNCA uses fórmulas formales, cierres corporativos ni pidas disculpas\n- NUNCA publiques WhatsApp, catálogo completo ni lista de precios en comentarios públicos\n\nDATOS DE LA EMPRESA:\n- Venta SOLO mayorista, mínimo $90.000, productos surtidos OK\n- Dirección: Av. Gaona 2376, zona Flores, CABA\n- Horario: Lunes a jueves 9-18, viernes 9-15. Fines de semana CERRADO\n- Envíos a todo el país, despacho en 48hs, costo aparte\n- Pagos: efectivo y transferencia sin recargo, tarjeta +20%\n- Web: blanqueriaxmayorista.com\n- NO venden en Mercado Libre\n- NO venden por menor\n- NO se necesita monotributo ni CUIT\n\nRESPUESTAS ESTÁNDAR:\n- Info/catálogo → \"Holis mándame un mensaje y te paso más info 🙌❤\"\n- Ubicación → \"Holis estamos en avenida Gaona 2376 zona flores\"\n- Envíos → \"Holis Sii hacemos envíos a todo el país 🙌\"\n- Mínimo → \"Holis el mínimo es de 90.000\"\n- Solo mayor → \"Holis nuestra venta es solo por mayor\"\n- WhatsApp → \"Holis mándame un mensaje y te lo paso\" (NUNCA darlo público)\n- Testimonio → solo emojis: ❤🔥🔥 o 🙌❤\n\nNO RESPONDER CUANDO:\n- Solo etiquetan amigos sin pregunta\n- Solo emojis sin pregunta\n- Spam\n- Ya hay respuesta del negocio"', 'System prompt for Claude')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- RBAC Permissions for AI Bot
-- ============================================================
INSERT INTO permissions (key, name, description, category) VALUES
  ('ai_bot.view', 'Ver Bot IA', 'Ver panel y estado del bot IA', 'Bot IA'),
  ('ai_bot.config', 'Configurar Bot IA', 'Modificar configuración del bot IA', 'Bot IA'),
  ('ai_bot.manage', 'Administrar Bot IA', 'Gestionar prompts, reglas y operación del bot IA', 'Bot IA')
ON CONFLICT (key) DO NOTHING;

-- Grant to admin role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'admin'
AND p.key IN ('ai_bot.view', 'ai_bot.config', 'ai_bot.manage')
ON CONFLICT DO NOTHING;

-- ============================================================
-- Additional indexes for high-volume performance
-- ============================================================

-- Composite index for webhook dedup lookups
CREATE INDEX IF NOT EXISTS idx_ai_bot_events_dedup ON ai_bot_events(event_id, status);

-- Index for rate limit queries (recent replies by channel)
CREATE INDEX IF NOT EXISTS idx_ai_bot_replies_recent ON ai_bot_replies(channel, created_at DESC) WHERE status = 'sent';

-- Index for metrics aggregation
CREATE INDEX IF NOT EXISTS idx_ai_bot_events_metrics ON ai_bot_events(created_at, channel, status);

-- ============================================================
-- Add updated_at to ai_bot_events
-- ============================================================

-- Add updated_at for tracking processing timestamps
ALTER TABLE ai_bot_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================
-- Auto-update trigger for ai_bot_config.updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_ai_bot_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_bot_config_updated_at ON ai_bot_config;
CREATE TRIGGER ai_bot_config_updated_at
  BEFORE UPDATE ON ai_bot_config
  FOR EACH ROW EXECUTE FUNCTION update_ai_bot_config_updated_at();
