/**
 * Servicio de Carga Masiva de Remitos
 * OCR + Fuzzy Matching + Sugerencia automática de pedido
 */

const pool = require('../db');

/**
 * Calcula distancia de Levenshtein entre dos strings
 */
function levenshteinDistance(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  const matrix = [];

  for (let i = 0; i <= s2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[s2.length][s1.length];
}

/**
 * Calcula score de similitud entre 0 y 1
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;

  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return 1;

  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(s1, s2);
  return 1 - (distance / maxLen);
}

/**
 * Normaliza texto para comparación
 * Remueve acentos, caracteres especiales, etc.
 */
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remover acentos
    .replace(/[^a-z0-9\s]/g, ' ')    // Solo alfanuméricos
    .replace(/\s+/g, ' ')            // Espacios múltiples → uno
    .trim();
}

/**
 * Extrae nombre probable del texto OCR
 * Busca patrones como "Destinatario:", "Nombre:", o líneas con nombres
 */
function extractName(ocrText) {
  if (!ocrText) return null;

  const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l);

  // Patrones de nombre
  const namePatterns = [
    /(?:destinatario|nombre|cliente|para|a nombre de|sr\.?|sra\.?)[\s:]+([a-záéíóúñ\s]+)/i,
    /^([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)+)$/m, // Línea que parece nombre propio
  ];

  for (const pattern of namePatterns) {
    const match = ocrText.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Validar que parezca un nombre (2+ palabras, no muy largo)
      if (name.split(/\s+/).length >= 2 && name.length < 50) {
        return name;
      }
    }
  }

  // Fallback: buscar línea que parezca nombre
  for (const line of lines.slice(0, 10)) {
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 5) {
      const looksLikeName = words.every(w =>
        /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/.test(w) && w.length >= 2
      );
      if (looksLikeName) {
        return line;
      }
    }
  }

  return null;
}

/**
 * Extrae dirección probable del texto OCR
 */
function extractAddress(ocrText) {
  if (!ocrText) return null;

  // Patrones de dirección
  const addressPatterns = [
    /(?:direcci[oó]n|domicilio|calle|av\.?|avenida)[\s:]+([^\n]+)/i,
    /(?:^|\n)([A-Za-záéíóúñ\s]+\s+\d{1,5}(?:\s*[,\-]\s*[^\n]+)?)/m, // Calle + número
  ];

  for (const pattern of addressPatterns) {
    const match = ocrText.match(pattern);
    if (match && match[1]) {
      const addr = match[1].trim();
      if (addr.length > 5 && addr.length < 100) {
        return addr;
      }
    }
  }

  return null;
}

/**
 * Extrae ciudad/localidad del texto OCR
 */
function extractCity(ocrText) {
  if (!ocrText) return null;

  const cityPatterns = [
    /(?:ciudad|localidad|partido|cp|c\.p\.)[\s:]+([^\n,]+)/i,
    /(?:buenos aires|caba|capital federal|córdoba|rosario|mendoza|la plata|mar del plata)/i,
  ];

  for (const pattern of cityPatterns) {
    const match = ocrText.match(pattern);
    if (match) {
      return (match[1] || match[0]).trim();
    }
  }

  return null;
}

/**
 * Busca el pedido que mejor coincide con los datos extraídos
 */
async function findBestMatch(detectedName, detectedAddress, detectedCity) {
  // Obtener pedidos recientes (últimos 30 días) con datos de envío
  const ordersRes = await pool.query(`
    SELECT
      order_number,
      customer_name,
      shipping_address->>'name' as shipping_name,
      shipping_address->>'address' as shipping_street,
      shipping_address->>'number' as shipping_number,
      shipping_address->>'locality' as shipping_locality,
      shipping_address->>'city' as shipping_city
    FROM orders_validated
    WHERE created_at > NOW() - INTERVAL '30 days'
      AND estado_pedido NOT IN ('cancelado', 'enviado')
      AND shipping_address IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 500
  `);

  const orders = ordersRes.rows;
  let bestMatch = null;
  let bestScore = 0;

  for (const order of orders) {
    const scores = {};
    let totalWeight = 0;
    let weightedScore = 0;

    // Comparar nombre
    if (detectedName) {
      const nameToCompare = order.shipping_name || order.customer_name || '';
      if (nameToCompare) {
        scores.name = calculateSimilarity(
          normalizeText(detectedName),
          normalizeText(nameToCompare)
        );
        weightedScore += scores.name * 0.4; // 40% peso
        totalWeight += 0.4;
      }
    }

    // Comparar dirección
    if (detectedAddress) {
      const fullAddress = [
        order.shipping_street,
        order.shipping_number
      ].filter(Boolean).join(' ');

      if (fullAddress) {
        scores.address = calculateSimilarity(
          normalizeText(detectedAddress),
          normalizeText(fullAddress)
        );
        weightedScore += scores.address * 0.4; // 40% peso
        totalWeight += 0.4;
      }
    }

    // Comparar ciudad/localidad
    if (detectedCity) {
      const cityToCompare = order.shipping_locality || order.shipping_city || '';
      if (cityToCompare) {
        scores.city = calculateSimilarity(
          normalizeText(detectedCity),
          normalizeText(cityToCompare)
        );
        weightedScore += scores.city * 0.2; // 20% peso
        totalWeight += 0.2;
      }
    }

    // Calcular score final
    const finalScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

    if (finalScore > bestScore && finalScore >= 0.5) { // Umbral mínimo 50%
      bestScore = finalScore;
      bestMatch = {
        orderNumber: order.order_number,
        score: finalScore,
        details: scores
      };
    }
  }

  return bestMatch;
}

/**
 * Procesa un documento con OCR y busca coincidencias
 */
async function processDocument(documentId, ocrText) {
  console.log(`🔍 Procesando documento ${documentId}...`);

  try {
    // Extraer datos del texto OCR
    const detectedName = extractName(ocrText);
    const detectedAddress = extractAddress(ocrText);
    const detectedCity = extractCity(ocrText);

    console.log(`   📝 Nombre detectado: ${detectedName || '(ninguno)'}`);
    console.log(`   📍 Dirección detectada: ${detectedAddress || '(ninguna)'}`);
    console.log(`   🏙️ Ciudad detectada: ${detectedCity || '(ninguna)'}`);

    // Buscar mejor coincidencia
    const match = await findBestMatch(detectedName, detectedAddress, detectedCity);

    if (match) {
      console.log(`   ✅ Match encontrado: #${match.orderNumber} (score: ${(match.score * 100).toFixed(1)}%)`);

      await pool.query(`
        UPDATE shipping_documents
        SET
          ocr_text = $1,
          ocr_processed_at = NOW(),
          detected_name = $2,
          detected_address = $3,
          detected_city = $4,
          suggested_order_number = $5,
          match_score = $6,
          match_details = $7,
          status = 'ready',
          updated_at = NOW()
        WHERE id = $8
      `, [
        ocrText,
        detectedName,
        detectedAddress,
        detectedCity,
        match.orderNumber,
        match.score,
        JSON.stringify(match.details),
        documentId
      ]);
    } else {
      console.log(`   ⚠️ No se encontró coincidencia`);

      await pool.query(`
        UPDATE shipping_documents
        SET
          ocr_text = $1,
          ocr_processed_at = NOW(),
          detected_name = $2,
          detected_address = $3,
          detected_city = $4,
          status = 'ready',
          updated_at = NOW()
        WHERE id = $5
      `, [
        ocrText,
        detectedName,
        detectedAddress,
        detectedCity,
        documentId
      ]);
    }

    return { success: true, match };

  } catch (error) {
    console.error(`   ❌ Error procesando documento ${documentId}:`, error.message);

    await pool.query(`
      UPDATE shipping_documents
      SET
        status = 'error',
        error_message = $1,
        updated_at = NOW()
      WHERE id = $2
    `, [error.message, documentId]);

    return { success: false, error: error.message };
  }
}

module.exports = {
  levenshteinDistance,
  calculateSimilarity,
  normalizeText,
  extractName,
  extractAddress,
  extractCity,
  findBestMatch,
  processDocument
};
