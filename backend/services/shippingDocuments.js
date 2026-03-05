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
 * Headers que indican inicio de sección DESTINATARIO
 */
const DESTINATION_HEADERS = [
  'destinatario',
  'destino',
  'enviar a',
  'entregar a',
  'consignatario',
  'datos de entrega',
  'direccion de entrega',
  'domicilio de entrega',
  'receptor',
  'cliente',
  'para:'
];

/**
 * Headers que indican secciones a EXCLUIR (no son destinatario)
 */
const EXCLUDE_HEADERS = [
  'remitente',
  'origen',
  'sucursal',
  'deposito',
  'depósito',
  'empresa',
  'transportista',
  'transporte',
  'emisor',
  'expedidor',
  'datos del remitente',
  'datos de origen',
  'retira en',
  'retire en'
];

/**
 * Stage A: Detecta si una línea es un header de sección
 */
function detectSectionHeader(line) {
  const normalized = normalizeText(line);

  for (const header of DESTINATION_HEADERS) {
    if (normalized.includes(normalizeText(header))) {
      return { type: 'destination', header };
    }
  }

  for (const header of EXCLUDE_HEADERS) {
    if (normalized.includes(normalizeText(header))) {
      return { type: 'exclude', header };
    }
  }

  return null;
}

/**
 * Stage B: Extrae solo la zona de DESTINATARIO del texto OCR
 * Retorna las líneas que pertenecen a la sección destinatario
 */
function extractDestinationZone(ocrText) {
  if (!ocrText) return { lines: [], confidence: 0, log: [] };

  const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l);
  const log = [];

  let inDestinationZone = false;
  let destinationLines = [];
  let foundDestinationHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerInfo = detectSectionHeader(line);

    if (headerInfo) {
      if (headerInfo.type === 'destination') {
        log.push(`📍 L${i}: Header DESTINO detectado: "${line}" (${headerInfo.header})`);
        inDestinationZone = true;
        foundDestinationHeader = true;
        // Incluir contenido después del header si está en la misma línea
        const afterHeader = line.split(/[:]\s*/)[1];
        if (afterHeader && afterHeader.trim()) {
          destinationLines.push(afterHeader.trim());
        }
        continue;
      } else if (headerInfo.type === 'exclude') {
        log.push(`🚫 L${i}: Header EXCLUIR detectado: "${line}" (${headerInfo.header})`);
        if (inDestinationZone) {
          log.push(`   ↳ Finalizando zona destinatario`);
        }
        inDestinationZone = false;
        continue;
      }
    }

    if (inDestinationZone) {
      // Filtrar líneas que parecen ser metadata o no relevantes
      if (!isMetadataLine(line)) {
        destinationLines.push(line);
        log.push(`✅ L${i}: Incluido en zona destino: "${line}"`);
      } else {
        log.push(`⏭️ L${i}: Omitido (metadata): "${line}"`);
      }
    }
  }

  // Calcular confianza
  let confidence = 0;
  if (foundDestinationHeader && destinationLines.length > 0) {
    confidence = 0.9; // Alta confianza: encontramos header explícito
  } else if (destinationLines.length > 0) {
    confidence = 0.5; // Media: tenemos datos pero sin header claro
  }

  log.push(`📊 Resultado: ${destinationLines.length} líneas, confianza: ${(confidence * 100).toFixed(0)}%`);

  return { lines: destinationLines, confidence, log, foundHeader: foundDestinationHeader };
}

/**
 * Detecta si una línea es metadata (fecha, código, etc.) y no datos de envío
 */
function isMetadataLine(line) {
  const metadataPatterns = [
    /^(?:fecha|date|nro|numero|código|codigo|ref|track|guia|guía)[\s:]/i,
    /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/, // Solo fecha
    /^[A-Z0-9\-]{8,}$/, // Solo código de tracking
    /^(?:total|subtotal|iva|precio|importe)[\s:]/i,
    /^\$[\d\.,]+$/, // Solo monto
    /^(?:peso|kg|kilos?)[\s:]/i,
    /^(?:bultos?|paquetes?|cajas?)[\s:]/i,
  ];

  return metadataPatterns.some(p => p.test(line.trim()));
}

/**
 * Extrae datos del destinatario de las líneas de la zona destino
 */
function extractDestinatarioFromZone(destinationLines) {
  const result = {
    name: null,
    address: null,
    city: null,
    extractionLog: []
  };

  if (!destinationLines.length) return result;

  const text = destinationLines.join('\n');

  // Extraer nombre
  result.name = extractNameFromDestination(destinationLines, result.extractionLog);

  // Extraer dirección
  result.address = extractAddressFromDestination(destinationLines, result.extractionLog);

  // Extraer ciudad
  result.city = extractCityFromDestination(destinationLines, result.extractionLog);

  return result;
}

/**
 * Extrae nombre del destinatario de las líneas filtradas
 */
function extractNameFromDestination(lines, log) {
  // Buscar línea con label de nombre
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/(?:nombre|sr\.?|sra\.?|a nombre de)[\s:]+(.+)/i);
    if (nameMatch && nameMatch[1]) {
      const name = nameMatch[1].trim();
      if (name.length >= 3 && name.length < 60) {
        log.push(`👤 Nombre extraído (con label): "${name}"`);
        return name;
      }
    }
  }

  // Buscar primera línea que parezca nombre propio
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i];
    const words = line.split(/\s+/);

    // Parece nombre: 2-5 palabras, cada una empieza con mayúscula
    if (words.length >= 2 && words.length <= 5) {
      const looksLikeName = words.every(w =>
        /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*\.?$/.test(w) && w.length >= 2
      );
      if (looksLikeName) {
        log.push(`👤 Nombre extraído (heurística): "${line}"`);
        return line;
      }
    }

    // Alternativa: "APELLIDO, Nombre"
    if (/^[A-ZÁÉÍÓÚÑ]+[,\s]+[A-Z][a-záéíóúñ]+/.test(line)) {
      log.push(`👤 Nombre extraído (formato APELLIDO, Nombre): "${line}"`);
      return line;
    }
  }

  log.push(`👤 Nombre: no encontrado`);
  return null;
}

/**
 * Extrae dirección del destinatario de las líneas filtradas
 */
function extractAddressFromDestination(lines, log) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Buscar con label
    const addrMatch = line.match(/(?:direcci[oó]n|domicilio|calle|av\.?|avenida)[\s:]+(.+)/i);
    if (addrMatch && addrMatch[1]) {
      const addr = addrMatch[1].trim();
      if (addr.length > 5) {
        log.push(`📍 Dirección extraída (con label): "${addr}"`);
        return addr;
      }
    }

    // Buscar patrón calle + número
    const streetMatch = line.match(/^([A-Za-záéíóúñ\s\.]+)\s+(\d{1,5})\s*(.*)$/);
    if (streetMatch) {
      const fullAddr = line.trim();
      if (fullAddr.length > 5 && fullAddr.length < 100) {
        log.push(`📍 Dirección extraída (calle + nro): "${fullAddr}"`);
        return fullAddr;
      }
    }
  }

  log.push(`📍 Dirección: no encontrada`);
  return null;
}

/**
 * Extrae ciudad/localidad del destinatario de las líneas filtradas
 */
function extractCityFromDestination(lines, log) {
  const cityPatterns = [
    /(?:ciudad|localidad|partido|provincia|cp|c\.p\.|loc\.)[\s:]+([^\n,]+)/i,
  ];

  const knownCities = [
    'buenos aires', 'caba', 'capital federal', 'córdoba', 'cordoba',
    'rosario', 'mendoza', 'la plata', 'mar del plata', 'san miguel',
    'san isidro', 'vicente lopez', 'vicente lópez', 'tigre', 'pilar',
    'morón', 'moron', 'quilmes', 'avellaneda', 'lanús', 'lanus',
    'lomas de zamora', 'florencio varela', 'berazategui', 'almirante brown',
    'ezeiza', 'esteban echeverría', 'merlo', 'moreno', 'josé c. paz',
    'san martín', 'san martin', 'tres de febrero', 'hurlingham', 'ituzaingó'
  ];

  for (const line of lines) {
    // Buscar con label
    for (const pattern of cityPatterns) {
      const match = line.match(pattern);
      if (match && match[1]) {
        log.push(`🏙️ Ciudad extraída (con label): "${match[1].trim()}"`);
        return match[1].trim();
      }
    }

    // Buscar ciudades conocidas
    const normalizedLine = normalizeText(line);
    for (const city of knownCities) {
      if (normalizedLine.includes(normalizeText(city))) {
        log.push(`🏙️ Ciudad extraída (conocida): "${city}"`);
        return city;
      }
    }
  }

  log.push(`🏙️ Ciudad: no encontrada`);
  return null;
}

/**
 * Stage D: Extracción completa con scoring de confianza
 * Esta función reemplaza extractName, extractAddress, extractCity
 */
function extractDestinatarioFromOcr(ocrText) {
  const result = {
    name: null,
    address: null,
    city: null,
    confidence: 0,
    log: []
  };

  if (!ocrText) return result;

  result.log.push('=== INICIO EXTRACCIÓN DESTINATARIO ===');

  // Stage A+B: Extraer zona de destinatario
  const zoneResult = extractDestinationZone(ocrText);
  result.log.push(...zoneResult.log);

  if (zoneResult.lines.length === 0) {
    // Fallback: si no encontramos zona de destino, usar todo el texto
    // pero con confianza reducida
    result.log.push('⚠️ No se detectó zona destinatario, usando fallback con todo el texto');
    const allLines = ocrText.split('\n').map(l => l.trim()).filter(l => l && !isMetadataLine(l));
    const extracted = extractDestinatarioFromZone(allLines);
    result.name = extracted.name;
    result.address = extracted.address;
    result.city = extracted.city;
    result.confidence = 0.3; // Baja confianza
    result.log.push(...extracted.extractionLog);
  } else {
    // Extraer datos de la zona identificada
    const extracted = extractDestinatarioFromZone(zoneResult.lines);
    result.name = extracted.name;
    result.address = extracted.address;
    result.city = extracted.city;
    result.log.push(...extracted.extractionLog);

    // Calcular confianza final
    let dataConfidence = 0;
    if (result.name) dataConfidence += 0.4;
    if (result.address) dataConfidence += 0.4;
    if (result.city) dataConfidence += 0.2;

    result.confidence = zoneResult.confidence * dataConfidence;
  }

  result.log.push(`=== RESULTADO FINAL: confianza ${(result.confidence * 100).toFixed(0)}% ===`);

  return result;
}

// Funciones legacy para compatibilidad (ahora usan el nuevo sistema)
function extractName(ocrText) {
  return extractDestinatarioFromOcr(ocrText).name;
}

function extractAddress(ocrText) {
  return extractDestinatarioFromOcr(ocrText).address;
}

function extractCity(ocrText) {
  return extractDestinatarioFromOcr(ocrText).city;
}

/**
 * Busca el pedido que mejor coincide con los datos extraídos
 *
 * IMPORTANTE: El matching usa EXCLUSIVAMENTE datos de shipping_requests
 * (formulario petlovearg.com/envio), NO datos de Tiendanube.
 *
 * Si un pedido no tiene registro en shipping_requests, NO se sugiere match.
 * Esto es intencional: los remitos solo aplican a pedidos con transporte.
 */
async function findBestMatch(detectedName, detectedAddress, detectedCity) {
  // Obtener datos de envío del formulario /envio (shipping_requests)
  // NO usar orders_validated.shipping_address (datos de Tiendanube)
  const shippingRes = await pool.query(`
    SELECT
      sr.order_number,
      sr.nombre_apellido,
      sr.direccion_entrega,
      sr.localidad,
      sr.provincia,
      sr.codigo_postal,
      sr.empresa_envio,
      sr.destino_tipo,
      ov.estado_pedido
    FROM shipping_requests sr
    INNER JOIN orders_validated ov ON sr.order_number = ov.order_number
    WHERE sr.created_at > NOW() - INTERVAL '60 days'
      AND ov.estado_pedido NOT IN ('cancelado', 'enviado', 'retirado')
    ORDER BY sr.created_at DESC
    LIMIT 500
  `);

  const shippingData = shippingRes.rows;

  console.log(`   📋 Buscando match en ${shippingData.length} registros de shipping_requests`);

  if (shippingData.length === 0) {
    console.log(`   ⚠️ No hay registros en shipping_requests para comparar`);
    return null;
  }

  let bestMatch = null;
  let bestScore = 0;

  for (const shipping of shippingData) {
    const scores = {};
    let totalWeight = 0;
    let weightedScore = 0;

    // Comparar nombre (nombre_apellido del formulario)
    if (detectedName && shipping.nombre_apellido) {
      scores.name = calculateSimilarity(
        normalizeText(detectedName),
        normalizeText(shipping.nombre_apellido)
      );
      weightedScore += scores.name * 0.4; // 40% peso
      totalWeight += 0.4;
    }

    // Comparar dirección (direccion_entrega del formulario)
    if (detectedAddress && shipping.direccion_entrega) {
      scores.address = calculateSimilarity(
        normalizeText(detectedAddress),
        normalizeText(shipping.direccion_entrega)
      );
      weightedScore += scores.address * 0.4; // 40% peso
      totalWeight += 0.4;
    }

    // Comparar ciudad/localidad (localidad del formulario)
    if (detectedCity && shipping.localidad) {
      scores.city = calculateSimilarity(
        normalizeText(detectedCity),
        normalizeText(shipping.localidad)
      );
      weightedScore += scores.city * 0.2; // 20% peso
      totalWeight += 0.2;
    }

    // Calcular score final
    const finalScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

    if (finalScore > bestScore && finalScore >= 0.5) { // Umbral mínimo 50%
      bestScore = finalScore;
      bestMatch = {
        orderNumber: shipping.order_number,
        score: finalScore,
        details: {
          ...scores,
          source: 'shipping_requests', // Indicar fuente de datos
          empresa_envio: shipping.empresa_envio,
          destino_tipo: shipping.destino_tipo
        }
      };
    }
  }

  if (bestMatch) {
    console.log(`   🎯 Match encontrado via shipping_requests: #${bestMatch.orderNumber}`);
  } else {
    console.log(`   ❌ Sin match en shipping_requests (score < 50%)`);
  }

  return bestMatch;
}

/**
 * Procesa un documento con OCR y busca coincidencias
 */
async function processDocument(documentId, ocrText) {
  console.log(`🔍 Procesando documento ${documentId}...`);

  try {
    // Extraer datos del texto OCR usando el nuevo sistema
    const extraction = extractDestinatarioFromOcr(ocrText);

    console.log(`   📝 Extracción con confianza: ${(extraction.confidence * 100).toFixed(0)}%`);
    console.log(`   👤 Nombre detectado: ${extraction.name || '(ninguno)'}`);
    console.log(`   📍 Dirección detectada: ${extraction.address || '(ninguna)'}`);
    console.log(`   🏙️ Ciudad detectada: ${extraction.city || '(ninguna)'}`);

    // Log detallado de extracción (útil para debugging)
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG_OCR) {
      console.log('   --- Log de extracción ---');
      extraction.log.forEach(l => console.log(`   ${l}`));
      console.log('   --- Fin log ---');
    }

    let match = null;

    // Solo buscar match si la confianza de extracción es suficiente
    if (extraction.confidence >= 0.2 && (extraction.name || extraction.address)) {
      match = await findBestMatch(extraction.name, extraction.address, extraction.city);
    } else {
      console.log(`   ⚠️ Confianza muy baja (${(extraction.confidence * 100).toFixed(0)}%), no se busca match`);
    }

    // Construir detalles del match
    // NOTA: El matching usa SOLO datos de shipping_requests (formulario /envio)
    // Si no hay registro en shipping_requests, no se sugiere pedido
    const matchDetails = match ? {
      ...match.details,
      extractionConfidence: extraction.confidence,
      extractionLog: extraction.log,
      matchSource: 'shipping_requests' // Indicar que vino del formulario /envio
    } : {
      extractionConfidence: extraction.confidence,
      extractionLog: extraction.log,
      noMatchReason: extraction.confidence < 0.2
        ? 'extraction_confidence_too_low'
        : 'no_shipping_request_match', // No hay match en shipping_requests
      note: 'El matching usa exclusivamente datos del formulario /envio (shipping_requests)'
    };

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
        extraction.name,
        extraction.address,
        extraction.city,
        match.orderNumber,
        match.score,
        JSON.stringify(matchDetails),
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
          match_details = $5,
          status = 'ready',
          updated_at = NOW()
        WHERE id = $6
      `, [
        ocrText,
        extraction.name,
        extraction.address,
        extraction.city,
        JSON.stringify(matchDetails),
        documentId
      ]);
    }

    return { success: true, match, extraction };

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
  extractDestinatarioFromOcr,
  extractDestinationZone,
  findBestMatch,
  processDocument
};
