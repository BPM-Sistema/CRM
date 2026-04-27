/**
 * Canonicalización de nombres de transporte.
 *
 * El campo empresa_envio_otro es texto libre y acumula typos: MORABITO /
 * MORABIRO, BUS PACK / BUSPACK, TAS / T.A.S / TASCAR / TAS EXPRESO, etc.
 *
 * Esta lib resuelve cada raw a un nombre canónico usando Claude y guarda
 * el resultado en `carrier_aliases`. Pensado para correrse en cron semanal
 * (no en cada request del ranking).
 */

const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/**
 * Normaliza un texto de transporte: upper, sin acentos, sin prefijos comunes
 * (TRANSPORTE / EXPRESO / EMPRESA / TTE / EXP), espacios colapsados.
 *
 * Match con la normalización SQL del endpoint del ranking.
 */
function normalizeCarrierRaw(raw) {
  if (raw === null || raw === undefined) return '';
  let v = String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  // Quitar prefijos comunes (mismo regex que el SQL del endpoint).
  v = v.replace(/^(TRANSPORTE |EXPRESO |EMPRESA |TTE |EXP )+/, '').trim();
  return v;
}

const SYSTEM_PROMPT = `Sos un asistente que normaliza nombres de empresas de transporte/expreso argentinas.
Recibís una lista de nombres tal como los escribieron clientes en un formulario (texto libre, hay typos, abreviaturas, sufijos sobrantes y a veces texto que NO es un transporte).
Tu tarea: para cada entrada, devolver el NOMBRE CANÓNICO de la empresa (sin prefijos como "TRANSPORTE/EXPRESO/EMPRESA"; sin sufijos como "A DOMICILIO/SUCURSAL"; sin direcciones; en mayúsculas).

REGLAS:
- Agrupá variantes obvias bajo el mismo canónico:
    "MORABITO" / "MORABIRO" → "MORABITO"
    "BUS PACK" / "BUSPACK" → "BUS PACK"
    "TAS" / "T.A.S" / "TAS EXPRESO" / "TASCAR" → "TAS"
    "EL VASQUITO" / "EL VAZQUITO" / "TTE EL VASQUITO" → "EL VASQUITO"
    "MARMISOLLE" / "MARMISSOLLE" → "MARMISOLLE"
    "GOIZUETA" / "GOIZUETA A DOMICILIO" → "GOIZUETA"
- Si la entrada NO es un transporte (basura, dirección entera, mensaje del cliente, "BO SE CUAL", una sola letra "E", etc.), devolvé null.
- "VIA CARGO" / "VIACARGO" / "VIA-CARGO" → "VIA CARGO".
- "OCA", "ANDREANI", "CORREO ARGENTINO" devolvelos tal cual (aunque después se filtran del ranking).
- Devolvé SOLO un JSON válido con la forma {"raw": "canónico"} (canónico puede ser null). Sin texto adicional, sin markdown.
- Si dudás, agrupá conservadoramente — preferí dejar dos canónicos diferentes antes que mezclar dos transportes que pueden ser distintos.`;

async function askClaudeBatch(rawList) {
  if (!client) {
    return Object.fromEntries(rawList.map(r => [r, { canonical: null, source: 'unknown' }]));
  }
  const userMessage = `Lista:\n${rawList.map(r => `- ${r}`).join('\n')}\n\nDevolvé el JSON.`;
  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
    ]);
    const text = (response.content?.[0]?.text || '').trim();
    // Extraer el primer bloque JSON (por si Claude pone algo antes/después).
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON in response');
    const parsed = JSON.parse(match[0]);
    const out = {};
    for (const raw of rawList) {
      if (Object.prototype.hasOwnProperty.call(parsed, raw)) {
        const canonical = parsed[raw];
        if (canonical === null || canonical === undefined) {
          out[raw] = { canonical: null, source: 'unknown' };
        } else {
          out[raw] = { canonical: String(canonical).trim(), source: 'claude' };
        }
      } else {
        // El modelo no devolvió esa entrada. Marcamos como unknown para no
        // re-preguntar; un humano puede overridear con source='manual'.
        out[raw] = { canonical: null, source: 'unknown' };
      }
    }
    return out;
  } catch (err) {
    console.warn(`carrierResolver: Claude falló para batch de ${rawList.length}: ${err.message}`);
    // Sin error: devolvemos {} y el caller decide. No cacheamos errores.
    return Object.fromEntries(rawList.map(r => [r, { canonical: null, source: 'error' }]));
  }
}

/**
 * Procesa todos los carriers raw que aún no están en cache, los pasa por
 * Claude (en batches) y guarda el resultado.
 *
 * Devuelve `{ resolved, skipped, errors }` con conteos.
 */
async function canonicalizeAllCarriers({ batchSize = 30 } = {}) {
  // Tomar todos los raws distintos de las dos tablas que alimentan el ranking.
  const rawsRes = await pool.query(`
    WITH all_raws AS (
      SELECT empresa_envio_otro AS raw FROM shipping_requests
        WHERE empresa_envio = 'OTRO' AND empresa_envio_otro IS NOT NULL
      UNION
      SELECT empresa_envio_raw AS raw FROM shipping_requests_historico
        WHERE empresa_envio_raw IS NOT NULL
    )
    SELECT DISTINCT raw FROM all_raws
  `);

  const allNormalized = new Set();
  for (const row of rawsRes.rows) {
    const norm = normalizeCarrierRaw(row.raw);
    if (norm) allNormalized.add(norm);
  }

  // Cuáles ya están cacheados.
  const cachedRes = await pool.query('SELECT raw_input FROM carrier_aliases');
  const cached = new Set(cachedRes.rows.map(r => r.raw_input));

  const pending = [...allNormalized].filter(n => !cached.has(n));
  console.log(`carrierResolver: ${cached.size} cacheados, ${pending.length} a resolver`);

  if (pending.length === 0) {
    return { resolved: 0, skipped: 0, errors: 0, total_pending: 0 };
  }

  let resolved = 0;
  let errors = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const map = await askClaudeBatch(batch);
    const toCache = [];
    for (const raw of batch) {
      const r = map[raw];
      if (!r || r.source === 'error') {
        errors++;
        continue;
      }
      toCache.push({ raw, canonical: r.canonical, source: r.source });
    }
    if (toCache.length > 0) {
      const values = toCache.map((_, idx) => `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`).join(', ');
      const params = toCache.flatMap(c => [c.raw, c.canonical, c.source]);
      await pool.query(
        `INSERT INTO carrier_aliases (raw_input, canonical, source) VALUES ${values}
         ON CONFLICT (raw_input) DO NOTHING`,
        params
      );
      resolved += toCache.length;
    }
    console.log(`carrierResolver: batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(pending.length / batchSize)} → ${toCache.length} guardados`);
  }

  return { resolved, errors, total_pending: pending.length };
}

/**
 * Carga el cache completo de carrier_aliases. Devuelve un Map raw → canonical
 * (canonical puede ser null para entradas marcadas como no identificables).
 */
async function loadCarrierAliases() {
  const res = await pool.query('SELECT raw_input, canonical FROM carrier_aliases');
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.raw_input, row.canonical);
  }
  return map;
}

module.exports = {
  normalizeCarrierRaw,
  canonicalizeAllCarriers,
  loadCarrierAliases,
};
