-- Migration 030: waspy_config table for API Key-based Waspy integration
-- Replaces env-based JWT config with DB-stored API key

CREATE TABLE IF NOT EXISTS waspy_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key TEXT NOT NULL,
  tenant_id TEXT,
  tenant_name TEXT,
  waspy_url TEXT NOT NULL DEFAULT 'http://localhost:8080',
  embed_url TEXT NOT NULL DEFAULT 'http://localhost:3000/embed/inbox',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Only one active config allowed
CREATE UNIQUE INDEX IF NOT EXISTS waspy_config_singleton ON waspy_config ((true));
