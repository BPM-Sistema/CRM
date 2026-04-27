-- 067: cache de aliases de provincia → nombre canónico
-- Motivación: el ranking de transportes agrupa por provincia, pero el campo
-- shipping_requests.provincia es texto libre y tiene cientos de variantes
-- (typos, abreviaturas, mayúsculas/minúsculas, etc.). El CASE WHEN hardcoded
-- en el endpoint solo cubre ~15 casos comunes.
--
-- Esta tabla guarda el resultado de cada resolución: o bien matcheada contra
-- la lista canónica de 24 provincias del IGN, o bien resuelta por Claude
-- (cuando no hay match directo). Una vez resuelta una entrada, no hace falta
-- volver a llamar al modelo.
--
-- raw_input: el texto crudo NORMALIZADO (upper, sin acentos, trim, espacios
--   colapsados). Igual al output del helper normalizeProvinceRaw del backend.
-- canonical: nombre canónico de la provincia (de la lista de 24), o NULL
--   si Claude no pudo identificarla (basura, "asd", emails, etc.).
-- source: 'manual' (matcheo directo contra la tabla canónica), 'claude'
--   (resuelto por Claude), 'unknown' (Claude no pudo identificarla).

CREATE TABLE IF NOT EXISTS province_aliases (
  raw_input TEXT PRIMARY KEY,
  canonical TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual', 'claude', 'unknown')),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_province_aliases_canonical
  ON province_aliases (canonical)
  WHERE canonical IS NOT NULL;
