-- =====================================================
-- Migración 091: Waspy outbound para marketing/avisos
--
-- Suma soporte para enviar avisos (back-in-stock) por un canal Waspy
-- separado del transaccional Botmaker. Aditiva: NO toca ninguna columna
-- ni tabla del flow Botmaker. Default del proveedor = botmaker, así que
-- correrla NO cambia el comportamiento actual hasta que un UPDATE manual
-- prenda waspy.
--
-- Canal target: e713decb-668f-47a0-bd28-e733cce7e8bf
--   "Blanqueria X Mayor Avisos" (+5491128392709)
--   WABA: 1519933012855679
--   Template aprobado: stock_alert_reingreso_v2
--
-- IMPORTANTE: el API key de Waspy NO va en esta migration (es secret).
-- Después de aplicar la migration, cargarlo con un UPDATE manual:
--
--   UPDATE waspy_config
--      SET marketing_api_key = 'wspy_...',
--          marketing_verified_at = NOW();
--
-- Rollback manual (si hace falta):
--   ALTER TABLE waspy_config DROP COLUMN marketing_api_key;
--   ALTER TABLE waspy_config DROP COLUMN marketing_phone_number_id;
--   ALTER TABLE waspy_config DROP COLUMN marketing_phone_e164;
--   ALTER TABLE waspy_config DROP COLUMN marketing_waba_id;
--   ALTER TABLE waspy_config DROP COLUMN marketing_base_url;
--   ALTER TABLE waspy_config DROP COLUMN marketing_verified_at;
--   ALTER TABLE stock_alerts DROP COLUMN notified_provider;
--   ALTER TABLE stock_alerts DROP COLUMN provider_message_id;
--   DELETE FROM integration_config WHERE key = 'stock_alert_provider';
-- =====================================================

BEGIN;

-- ─── 1. waspy_config: relajar api_key + sumar columnas marketing ───
-- El api_key original era para la integración inbox-iframe (ya removida del
-- código). Lo dejamos nullable para que la fila pueda existir solo con
-- config de marketing si el inbox no se usa.
ALTER TABLE waspy_config ALTER COLUMN api_key DROP NOT NULL;

ALTER TABLE waspy_config ADD COLUMN IF NOT EXISTS marketing_api_key         TEXT;
ALTER TABLE waspy_config ADD COLUMN IF NOT EXISTS marketing_phone_number_id TEXT;
ALTER TABLE waspy_config ADD COLUMN IF NOT EXISTS marketing_phone_e164      TEXT;
ALTER TABLE waspy_config ADD COLUMN IF NOT EXISTS marketing_waba_id         TEXT;
ALTER TABLE waspy_config ADD COLUMN IF NOT EXISTS marketing_base_url        TEXT;
ALTER TABLE waspy_config ADD COLUMN IF NOT EXISTS marketing_verified_at     TIMESTAMPTZ;

-- Upsert de los datos públicos del canal (NO el token; eso va por UPDATE
-- manual aparte). El singleton de la tabla garantiza una sola fila.
-- Usamos DO block en vez de ON CONFLICT ((true)) para evitar edge cases
-- con índices expresionales y dejar la lógica explícita para review.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM waspy_config) THEN
    -- Caso A: tabla vacía → crear la única fila singleton.
    INSERT INTO waspy_config (
      marketing_phone_number_id,
      marketing_phone_e164,
      marketing_waba_id,
      marketing_base_url
    )
    VALUES (
      'e713decb-668f-47a0-bd28-e733cce7e8bf',
      '+5491128392709',
      '1519933012855679',
      'https://api.waspytech.com/api/v2'
    );
  ELSE
    -- Caso B: ya hay fila (probablemente con api_key del inbox viejo) →
    -- solo rellenar marketing_* si están NULL. NO sobrescribir si alguien
    -- ya cargó valores diferentes (idempotencia).
    UPDATE waspy_config SET
      marketing_phone_number_id = COALESCE(marketing_phone_number_id, 'e713decb-668f-47a0-bd28-e733cce7e8bf'),
      marketing_phone_e164      = COALESCE(marketing_phone_e164,      '+5491128392709'),
      marketing_waba_id         = COALESCE(marketing_waba_id,         '1519933012855679'),
      marketing_base_url        = COALESCE(marketing_base_url,        'https://api.waspytech.com/api/v2');
  END IF;
END $$;

-- ─── 2. stock_alerts: auditoría por proveedor ───
-- Ambas columnas son nullable; las filas históricas notificadas por
-- Botmaker quedan con NULL (provider desconocido pero implícito por la
-- ventana de tiempo previa al deploy de Waspy).
ALTER TABLE stock_alerts ADD COLUMN IF NOT EXISTS notified_provider   TEXT;
ALTER TABLE stock_alerts ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

-- ─── 3. integration_config: toggle del proveedor (default botmaker) ───
-- enabled=true significa "el feature de aviso de stock está activo".
-- metadata.provider ('botmaker' | 'waspy') decide el sender.
-- Para switchear a Waspy:
--   UPDATE integration_config
--      SET metadata = jsonb_set(metadata, '{provider}', '"waspy"')
--    WHERE key = 'stock_alert_provider';
-- Para volver a Botmaker:
--   UPDATE integration_config
--      SET metadata = jsonb_set(metadata, '{provider}', '"botmaker"')
--    WHERE key = 'stock_alert_provider';
INSERT INTO integration_config (key, enabled, description, category, metadata)
VALUES (
  'stock_alert_provider',
  true,
  'Proveedor activo para envío de avisos de stock (botmaker | waspy)',
  'whatsapp',
  '{"provider": "botmaker", "approved_template_waspy": "stock_alert_reingreso_v2"}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
