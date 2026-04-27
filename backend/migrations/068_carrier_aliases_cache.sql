-- 068: cache de aliases de transporte → nombre canónico
-- Motivación: en el ranking de transportes (TransportesRanking) aparecen
-- muchas entradas duplicadas por typos: MORABITO/MORABIRO, BUS PACK/BUSPACK,
-- TAS/T.A.S/TASCAR/TAS EXPRESO, EL VASQUITO/EL VAZQUITO, etc.
--
-- Igual que con province_aliases (067), cacheamos el resultado de cada
-- resolución. Se llena con un cron semanal que pasa todos los raws nuevos
-- por Claude y le pide un nombre canónico que unifique los typos.
--
-- raw_input: el texto crudo NORMALIZADO del transporte (upper, sin acentos,
--   sin prefijos "TRANSPORTE/EXPRESO/EMPRESA").
-- canonical: nombre canónico (ej. "MORABITO", "BUS PACK"). NULL si no es
--   identificable como transporte (basura, dirección entera escrita en el
--   campo, email, etc.).
-- source: 'claude' (resuelto por el modelo), 'manual' (override humano si lo
--   queremos en el futuro), 'unknown' (modelo dijo que no es identificable).

CREATE TABLE IF NOT EXISTS carrier_aliases (
  raw_input TEXT PRIMARY KEY,
  canonical TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual', 'claude', 'unknown')),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carrier_aliases_canonical
  ON carrier_aliases (canonical)
  WHERE canonical IS NOT NULL;
