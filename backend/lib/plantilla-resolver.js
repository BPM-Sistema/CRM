/**
 * Plantilla Resolver
 *
 * Central function to resolve WhatsApp template names.
 * Uses the catalog-based system (plantilla_tipos + financiera_plantillas).
 *
 * NO dynamic string construction.
 * NO hardcoded suffixes.
 * Uses explicit mappings from the database.
 */

const pool = require('../db');

// ============================================
// CACHE CONFIGURATION
// ============================================
let tiposCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get all plantilla tipos from cache or DB
 * @returns {Promise<Array>} Array of plantilla_tipos records
 */
async function getPlantillaTipos() {
  const now = Date.now();

  if (tiposCache && (now - cacheTimestamp) < CACHE_TTL) {
    return tiposCache;
  }

  try {
    const result = await pool.query(`
      SELECT id, key, requiere_variante, plantilla_default
      FROM plantilla_tipos
      ORDER BY id
    `);
    tiposCache = result.rows;
    cacheTimestamp = now;
    return tiposCache;
  } catch (err) {
    console.error('[PlantillaResolver] Error loading tipos cache:', err.message);
    // Return empty array on error - fallback will handle it
    return [];
  }
}

/**
 * Clear the tipos cache (useful after admin changes)
 */
function clearCache() {
  tiposCache = null;
  cacheTimestamp = 0;
  console.log('[PlantillaResolver] Cache cleared');
}

/**
 * Resolve the final template name for a given plantilla key
 *
 * Resolution order:
 * 1. Explicit mapping for default financiera (if type requires variant)
 * 2. plantilla_default from catalog
 * 3. Original key (ultimate fallback)
 *
 * @param {string} plantillaKey - The template key (e.g., 'pedido_creado')
 * @returns {Promise<string>} The resolved template name to use in Botmaker
 */
async function getPlantillaFinal(plantillaKey) {
  try {
    // 1. Get catalog entry for this key
    const tipos = await getPlantillaTipos();
    const tipo = tipos.find(t => t.key === plantillaKey);

    // If type not in catalog, use key as-is (safe fallback)
    if (!tipo) {
      console.log(`[PlantillaResolver] Key "${plantillaKey}" not in catalog, using as-is`);
      return plantillaKey;
    }

    // 2. If type doesn't require variant, use default directly
    if (!tipo.requiere_variante) {
      console.log(`[PlantillaResolver] "${plantillaKey}" is universal, using default: ${tipo.plantilla_default}`);
      return tipo.plantilla_default;
    }

    // 3. Look up explicit mapping for default financiera
    const mapping = await pool.query(`
      SELECT fp.nombre_botmaker
      FROM financiera_plantillas fp
      JOIN financieras f ON f.id = fp.financiera_id
      WHERE f.is_default = true
        AND fp.plantilla_tipo_id = $1
      LIMIT 1
    `, [tipo.id]);

    if (mapping.rows.length > 0) {
      const resolved = mapping.rows[0].nombre_botmaker;
      console.log(`[PlantillaResolver] "${plantillaKey}" resolved to "${resolved}" (explicit mapping)`);
      return resolved;
    }

    // 4. No mapping found, use catalog default
    console.log(`[PlantillaResolver] "${plantillaKey}" no mapping found, using default: ${tipo.plantilla_default}`);
    return tipo.plantilla_default;

  } catch (err) {
    // On any error, fall back to original key (safe)
    console.error(`[PlantillaResolver] Error resolving "${plantillaKey}":`, err.message);
    return plantillaKey;
  }
}

/**
 * Get all mappings for a specific financiera
 * Used by the admin UI to show/edit mappings
 *
 * @param {number} financieraId - The financiera ID
 * @returns {Promise<Array>} Array of {tipo_key, tipo_nombre, nombre_botmaker}
 */
async function getMappingsForFinanciera(financieraId) {
  const result = await pool.query(`
    SELECT
      pt.id as tipo_id,
      pt.key as tipo_key,
      pt.nombre as tipo_nombre,
      pt.descripcion as tipo_descripcion,
      pt.requiere_variante,
      pt.plantilla_default,
      fp.nombre_botmaker
    FROM plantilla_tipos pt
    LEFT JOIN financiera_plantillas fp
      ON fp.plantilla_tipo_id = pt.id
      AND fp.financiera_id = $1
    WHERE pt.requiere_variante = true
    ORDER BY pt.id
  `, [financieraId]);

  return result.rows;
}

/**
 * Save or update a mapping for a financiera
 *
 * @param {number} financieraId - The financiera ID
 * @param {number} tipoId - The plantilla_tipo ID
 * @param {string} nombreBotmaker - The exact template name in Botmaker
 */
async function saveMapping(financieraId, tipoId, nombreBotmaker) {
  if (!nombreBotmaker || nombreBotmaker.trim() === '') {
    // Delete mapping if empty
    await pool.query(`
      DELETE FROM financiera_plantillas
      WHERE financiera_id = $1 AND plantilla_tipo_id = $2
    `, [financieraId, tipoId]);
    console.log(`[PlantillaResolver] Mapping deleted: financiera=${financieraId}, tipo=${tipoId}`);
    return null;
  }

  const result = await pool.query(`
    INSERT INTO financiera_plantillas (financiera_id, plantilla_tipo_id, nombre_botmaker, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (financiera_id, plantilla_tipo_id)
    DO UPDATE SET nombre_botmaker = $3, updated_at = NOW()
    RETURNING *
  `, [financieraId, tipoId, nombreBotmaker.trim()]);

  console.log(`[PlantillaResolver] Mapping saved: financiera=${financieraId}, tipo=${tipoId}, nombre=${nombreBotmaker}`);
  return result.rows[0];
}

/**
 * Save multiple mappings for a financiera at once
 * Used when saving the financiera form
 *
 * @param {number} financieraId - The financiera ID
 * @param {Array<{tipoId: number, nombreBotmaker: string}>} mappings - Array of mappings
 */
async function saveMappings(financieraId, mappings) {
  for (const { tipoId, nombreBotmaker } of mappings) {
    await saveMapping(financieraId, tipoId, nombreBotmaker);
  }
  clearCache(); // Clear cache after changes
}

module.exports = {
  getPlantillaFinal,
  getMappingsForFinanciera,
  saveMapping,
  saveMappings,
  clearCache,
  getPlantillaTipos,
};
