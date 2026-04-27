/**
 * Resuelve un texto crudo de provincia a su nombre canónico.
 *
 * Orden de resolución:
 *   1) Match directo contra alias canónicos (`lib/provinces.js`).
 *   2) Cache en DB (`province_aliases`).
 *   3) Llamada a Claude (Haiku 4.5) con timeout corto. El resultado se
 *      cachea (incluso si el modelo no pudo resolverla → marcamos 'unknown'
 *      para no re-preguntar).
 *
 * Devuelve `null` cuando no se puede resolver — el ranking lo agrupa
 * aparte como "Desconocido".
 */

const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const {
  CANONICAL_NAMES,
  normalizeProvinceRaw,
  findCanonicalByAlias,
} = require('../lib/provinces');

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const SYSTEM_PROMPT = `Sos un sistema que identifica provincias argentinas.
Recibís un texto cualquiera y tenés que devolver SOLO el nombre exacto de la
provincia argentina a la que se refiere, eligiendo de esta lista:

${CANONICAL_NAMES.map(n => `- ${n}`).join('\n')}

REGLAS:
- Devolvé SOLO el nombre exacto de la provincia, tal como aparece arriba (con tildes).
- Si el texto no se refiere a ninguna provincia argentina (es basura, un email, números, una localidad de otro país, etc.), devolvé exactamente: NULL
- Si menciona una localidad/ciudad argentina (ej: "Mar del Plata", "Rosario", "Bariloche"), devolvé la provincia a la que pertenece.
- "CABA" / "Capital Federal" / "Ciudad de Buenos Aires" → "CABA" (no "Buenos Aires").
- No inventes ni expliques. Devolvé una sola línea con el nombre o NULL.`;

async function askClaude(rawNormalized) {
  if (!client) return { canonical: null, source: 'unknown' };

  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 32,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Texto: "${rawNormalized}"` }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);

    const text = (response.content?.[0]?.text || '').trim();
    if (!text || text.toUpperCase() === 'NULL') {
      return { canonical: null, source: 'unknown' };
    }
    if (CANONICAL_NAMES.includes(text)) {
      return { canonical: text, source: 'claude' };
    }
    // Modelo devolvió algo que no está en la lista. Lo descartamos.
    return { canonical: null, source: 'unknown' };
  } catch (err) {
    // No queremos romper el ranking si Claude falla / hay timeout. Devolvemos
    // null SIN cachear para reintentar la próxima vez.
    console.warn(`provinceResolver: Claude falló para "${rawNormalized}": ${err.message}`);
    return { canonical: null, source: 'error' };
  }
}

async function resolveProvinces(rawInputs) {
  // 1) Normalizar y deduplicar.
  const normalizedSet = new Set();
  const inputToNormalized = new Map();
  for (const raw of rawInputs) {
    const norm = normalizeProvinceRaw(raw);
    inputToNormalized.set(raw, norm);
    if (norm) normalizedSet.add(norm);
  }

  const result = new Map(); // normalized → canonical (o null)

  // 2) Match contra alias canónicos.
  const pendingForCache = [];
  for (const norm of normalizedSet) {
    const canonical = findCanonicalByAlias(norm);
    if (canonical) {
      result.set(norm, canonical);
    } else {
      pendingForCache.push(norm);
    }
  }

  // 3) Buscar en cache lo que quedó.
  if (pendingForCache.length > 0) {
    const cacheRes = await pool.query(
      'SELECT raw_input, canonical FROM province_aliases WHERE raw_input = ANY($1)',
      [pendingForCache]
    );
    const cached = new Set();
    for (const row of cacheRes.rows) {
      result.set(row.raw_input, row.canonical); // canonical puede ser null (unknown cacheado)
      cached.add(row.raw_input);
    }
    var pendingForClaude = pendingForCache.filter(n => !cached.has(n));
  } else {
    var pendingForClaude = [];
  }

  // 4) Resolver lo restante con Claude (en paralelo, máx 5 a la vez para no
  //    saturar la API). Cachear el resultado.
  if (pendingForClaude.length > 0 && client) {
    const CONCURRENCY = 5;
    for (let i = 0; i < pendingForClaude.length; i += CONCURRENCY) {
      const batch = pendingForClaude.slice(i, i + CONCURRENCY);
      const resolved = await Promise.all(batch.map(async norm => {
        const { canonical, source } = await askClaude(norm);
        return { norm, canonical, source };
      }));
      // Cachear los resueltos por Claude (manual / claude / unknown). Los que
      // fallaron por error de red/timeout NO se cachean.
      const toCache = resolved.filter(r => r.source !== 'error');
      if (toCache.length > 0) {
        const values = toCache.map((_, idx) => `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`).join(', ');
        const params = toCache.flatMap(r => [r.norm, r.canonical, r.source]);
        await pool.query(
          `INSERT INTO province_aliases (raw_input, canonical, source) VALUES ${values}
           ON CONFLICT (raw_input) DO NOTHING`,
          params
        );
      }
      for (const r of resolved) {
        result.set(r.norm, r.canonical);
      }
    }
  } else if (pendingForClaude.length > 0 && !client) {
    // Sin API key: dejar como null para que vayan al cubo "Desconocido".
    for (const norm of pendingForClaude) result.set(norm, null);
  }

  // 5) Devolver un Map raw → canonical (usando la normalización que usamos).
  const finalMap = new Map();
  for (const [raw, norm] of inputToNormalized.entries()) {
    finalMap.set(raw, norm ? result.get(norm) || null : null);
  }
  return finalMap;
}

module.exports = {
  resolveProvinces,
};
