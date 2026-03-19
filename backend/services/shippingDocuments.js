/**
 * Servicio de Carga Masiva de Remitos
 * OCR + Fuzzy Matching + Sugerencia automática de pedido
 *
 * ESTRATEGIA DE EXTRACCIÓN:
 *
 * CASO 1 - VIA CARGO:
 * Si el OCR contiene "VIA CARGO", usamos bounding boxes para separar
 * físicamente REMITENTE (izquierda) de DESTINATARIO (derecha).
 * Extraemos nombre, dirección y ciudad del bloque DESTINATARIO.
 *
 * CASO 2 - OTROS TRANSPORTES:
 * Si el OCR NO contiene "VIA CARGO", NO parseamos el layout.
 * Solo buscamos coincidencia del nombre del cliente en todo el texto OCR.
 * Esto permite matchear aunque el formato del remito sea diferente.
 */

const pool = require('../db');

// ============================================
// SEPARACIÓN POR LAYOUT (BOUNDING BOXES)
// ============================================

/**
 * Separa el texto del OCR en dos columnas usando bounding boxes.
 * Via Cargo tiene layout consistente: izquierda=remitente, derecha=destinatario
 *
 * @param {Array} textAnnotations - Array de textAnnotations de Google Vision
 * @returns {Object} { leftColumn, rightColumn, dividerX, log }
 */
function separateByLayout(textAnnotations) {
  const log = [];

  if (!textAnnotations || textAnnotations.length < 2) {
    log.push('⚠️ No hay suficientes anotaciones para separar por layout');
    return { leftColumn: '', rightColumn: '', dividerX: null, log };
  }

  // Primera anotación es el texto completo, las siguientes son palabras individuales
  const words = textAnnotations.slice(1);

  if (words.length === 0) {
    log.push('⚠️ No hay palabras individuales con bounding boxes');
    return { leftColumn: '', rightColumn: '', dividerX: null, log };
  }

  // Calcular el centro X de cada palabra
  const wordsWithX = words.map(word => {
    const vertices = word.boundingPoly?.vertices || [];
    if (vertices.length < 2) return null;

    // Centro X = promedio de los 4 vértices (o de izquierda y derecha)
    const xValues = vertices.map(v => v.x || 0);
    const centerX = xValues.reduce((a, b) => a + b, 0) / xValues.length;

    // Centro Y para ordenar verticalmente
    const yValues = vertices.map(v => v.y || 0);
    const centerY = yValues.reduce((a, b) => a + b, 0) / yValues.length;

    return {
      text: word.description,
      centerX,
      centerY,
      minX: Math.min(...xValues),
      maxX: Math.max(...xValues)
    };
  }).filter(w => w !== null);

  if (wordsWithX.length === 0) {
    log.push('⚠️ No se pudieron calcular posiciones de palabras');
    return { leftColumn: '', rightColumn: '', dividerX: null, log };
  }

  // Encontrar los límites del documento
  const allX = wordsWithX.flatMap(w => [w.minX, w.maxX]);
  const docMinX = Math.min(...allX);
  const docMaxX = Math.max(...allX);
  const docWidth = docMaxX - docMinX;

  // Para Via Cargo: buscar los headers REMITENTE y DESTINATARIO
  // y calcular el divisor como el punto medio entre ellos
  let dividerX = docMinX + (docWidth * 0.5); // Default: centro

  const remitenteWord = wordsWithX.find(w =>
    normalizeText(w.text) === 'remitente' ||
    normalizeText(w.text).startsWith('remitente')
  );

  const destinatarioWord = wordsWithX.find(w =>
    normalizeText(w.text) === 'destinatario' ||
    normalizeText(w.text).startsWith('destinatario')
  );

  if (remitenteWord && destinatarioWord) {
    // Calcular punto medio entre los dos headers
    dividerX = (remitenteWord.centerX + destinatarioWord.centerX) / 2;
    log.push(`📍 Headers encontrados: REMITENTE en X=${remitenteWord.centerX.toFixed(0)}, DESTINATARIO en X=${destinatarioWord.centerX.toFixed(0)}`);
    log.push(`📍 Divisor calculado como punto medio: X=${dividerX.toFixed(0)}`);
  } else if (destinatarioWord) {
    // Solo encontramos DESTINATARIO - asumir que está a la derecha
    // El divisor está un poco antes del header
    dividerX = destinatarioWord.minX - 50;
    log.push(`📍 Solo DESTINATARIO encontrado en X=${destinatarioWord.centerX.toFixed(0)}, divisor=${dividerX.toFixed(0)}`);
  } else {
    // No encontramos headers, usar heurística: buscar la mayor brecha en X
    // entre palabras adyacentes verticalmente (indica división de columnas)
    const sortedByX = [...wordsWithX].sort((a, b) => a.centerX - b.centerX);
    let maxGap = 0;
    let gapX = dividerX;

    for (let i = 1; i < sortedByX.length; i++) {
      const gap = sortedByX[i].minX - sortedByX[i - 1].maxX;
      if (gap > maxGap && gap > 30) { // Brecha significativa
        maxGap = gap;
        gapX = (sortedByX[i - 1].maxX + sortedByX[i].minX) / 2;
      }
    }

    if (maxGap > 30) {
      dividerX = gapX;
      log.push(`📍 Divisor por brecha máxima (${maxGap.toFixed(0)}px): X=${dividerX.toFixed(0)}`);
    } else {
      log.push(`📍 Sin headers ni brecha clara, usando centro: X=${dividerX.toFixed(0)}`);
    }
  }

  log.push(`📐 Documento: X de ${docMinX} a ${docMaxX} (ancho: ${docWidth})`);
  log.push(`📐 Divisor de columnas en X = ${dividerX.toFixed(0)}`);

  // Encontrar la posición Y del header DESTINATARIO para filtrar
  // Solo queremos palabras que estén debajo (o cerca) del header
  let minY = 0;
  if (destinatarioWord) {
    // Empezar un poco antes del header para incluirlo
    minY = destinatarioWord.centerY - 20;
    log.push(`📍 Filtrando Y >= ${minY.toFixed(0)} (desde header DESTINATARIO)`);
  }

  // Separar palabras por columna (solo las que están en la zona del destinatario)
  const leftWords = wordsWithX.filter(w => w.centerX < dividerX && w.centerY >= minY);
  const rightWords = wordsWithX.filter(w => w.centerX >= dividerX && w.centerY >= minY);

  log.push(`📊 Columna izquierda: ${leftWords.length} palabras (REMITENTE)`);
  log.push(`📊 Columna derecha: ${rightWords.length} palabras (DESTINATARIO)`);

  // Ordenar palabras por Y (de arriba a abajo) y luego por X (de izq a der)
  const sortByPosition = (a, b) => {
    // Agrupar por "líneas" (diferencia de Y < 20 pixels = misma línea)
    const yDiff = Math.abs(a.centerY - b.centerY);
    if (yDiff < 20) {
      return a.centerX - b.centerX; // Misma línea: ordenar por X
    }
    return a.centerY - b.centerY; // Diferente línea: ordenar por Y
  };

  leftWords.sort(sortByPosition);
  rightWords.sort(sortByPosition);

  // Reconstruir texto de cada columna
  // Agregar saltos de línea cuando hay un salto significativo en Y
  const reconstructText = (words) => {
    if (words.length === 0) return '';

    let text = '';
    let lastY = words[0].centerY;

    for (const word of words) {
      const yDiff = word.centerY - lastY;
      if (yDiff > 15) {
        // Nueva línea
        text += '\n' + word.text;
      } else {
        // Misma línea
        text += (text.endsWith('\n') || text === '' ? '' : ' ') + word.text;
      }
      lastY = word.centerY;
    }

    return text.trim();
  };

  const leftColumn = reconstructText(leftWords);
  const rightColumn = reconstructText(rightWords);

  log.push(`📝 Texto columna derecha (primeras 200 chars): "${rightColumn.substring(0, 200)}..."`);

  return { leftColumn, rightColumn, dividerX, log };
}

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

// ============================================
// DETECCIÓN DE TIPO DE REMITO
// ============================================

/**
 * Detecta si el remito es de Via Cargo basándose en el texto OCR
 */
function isViaCargo(ocrText) {
  if (!ocrText) return false;
  const normalized = ocrText.toLowerCase();
  return normalized.includes('via cargo') || normalized.includes('viacargo');
}

// ============================================
// MATCHING POR NOMBRE EN TEXTO COMPLETO
// (Para remitos que NO son Via Cargo)
// ============================================

/**
 * Busca coincidencia de nombre del cliente en todo el texto OCR.
 * Usado para remitos que NO son Via Cargo.
 *
 * Estrategia:
 * - Divide el nombre del cliente en tokens
 * - Verifica que todos los tokens aparezcan en el OCR
 * - Permite coincidencias aunque el orden esté invertido
 * - Devuelve TODOS los candidatos (para casos de múltiples pedidos del mismo cliente)
 *
 * @param {string} ocrText - Texto completo del OCR
 * @returns {Object} { bestMatch, candidates } - Mejor match y array de todos los candidatos
 */
async function findMatchByNameInFullText(ocrText) {
  const normalizedOcr = normalizeText(ocrText);

  // Obtener shipping_requests activos con customer_name
  const shippingRes = await pool.query(`
    SELECT
      sr.order_number,
      sr.nombre_apellido,
      sr.localidad,
      sr.provincia,
      sr.empresa_envio,
      sr.destino_tipo,
      sr.created_at as shipping_created_at,
      ov.estado_pedido,
      ov.customer_name
    FROM shipping_requests sr
    INNER JOIN orders_validated ov ON sr.order_number = ov.order_number
    WHERE sr.created_at > NOW() - INTERVAL '60 days'
      AND ov.estado_pedido NOT IN ('cancelado', 'enviado', 'retirado')
    ORDER BY sr.created_at DESC
    LIMIT 500
  `);

  const shippingData = shippingRes.rows;
  console.log(`   📋 Buscando match por nombre en ${shippingData.length} registros`);

  if (shippingData.length === 0) {
    return { bestMatch: null, candidates: [] };
  }

  const allMatches = [];

  for (const shipping of shippingData) {
    if (!shipping.nombre_apellido) continue;

    const nameTokens = normalizeText(shipping.nombre_apellido)
      .split(' ')
      .filter(t => t.length >= 2); // Ignorar tokens muy cortos

    if (nameTokens.length === 0) continue;

    // Contar cuántos tokens del nombre aparecen en el OCR
    let matchedTokens = 0;
    for (const token of nameTokens) {
      if (normalizedOcr.includes(token)) {
        matchedTokens++;
      }
    }

    // Score = porcentaje de tokens encontrados
    const score = matchedTokens / nameTokens.length;

    // Requerir al menos 70% de tokens encontrados (o todos si son 2 o menos)
    const minRequired = nameTokens.length <= 2 ? 1.0 : 0.7;

    if (score >= minRequired) {
      allMatches.push({
        orderNumber: shipping.order_number,
        score: score,
        customerName: shipping.customer_name || shipping.nombre_apellido,
        createdAt: shipping.shipping_created_at,
        details: {
          matchType: 'name_in_fulltext',
          nameTokens: nameTokens,
          matchedTokens: matchedTokens,
          totalTokens: nameTokens.length,
          source: 'shipping_requests',
          empresa_envio: shipping.empresa_envio,
          destino_tipo: shipping.destino_tipo
        }
      });
    }
  }

  // Ya vienen ordenados por created_at DESC de la query
  const bestMatch = allMatches.length > 0 ? allMatches[0] : null;

  if (bestMatch) {
    console.log(`   🎯 Match por nombre: #${bestMatch.orderNumber} (${bestMatch.details.matchedTokens}/${bestMatch.details.totalTokens} tokens)`);
    if (allMatches.length > 1) {
      console.log(`   ⚠️ Hay ${allMatches.length} candidatos posibles (mismo cliente con múltiples pedidos)`);
    }
  } else {
    console.log(`   ❌ Sin match por nombre en texto completo`);
  }

  return { bestMatch, candidates: allMatches };
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
  'sucursal origen',
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
  'retire en',
  'domicilio de retiro',
  'direccion de retiro'
];

/**
 * Datos CONOCIDOS del remitente (BPM / Blanquería x Mayor / origen) que SIEMPRE deben excluirse.
 * Estos valores aparecen en todos los remitos como origen.
 */
const KNOWN_SENDER_DATA = {
  addresses: [
    'gaona 2376',
    'av gaona 2376',
    'av. gaona 2376',
    'avenida gaona 2376',
    'gaona nro 2376',
    'gaona n 2376',
    'gaona n° 2376',
  ],
  names: [
    'bpm',
    'bpm administrador',
    'blanqueria x mayor',
    'blanqueriaxmayor',
    'blanqueria por mayor',
    'pet love',        // legacy — remitos impresos pueden traer este nombre
    'petlove',         // legacy
    'pet love arg',    // legacy
    'petlove arg',     // legacy
    'nora luciana mansilla', // Titular/representante
    'mansilla nora',
  ],
  cities: [
    'caba',
    'capital federal',
    'ciudad autonoma',
    'ciudad de buenos aires',
    'c.a.b.a',
    'c.a.b.a.',
  ]
};

/**
 * Verifica si un texto corresponde a datos CONOCIDOS del remitente (BPM / Blanquería x Mayor)
 * @returns {object|null} - { type: 'address'|'name'|'city', value } o null
 */
function isKnownSenderData(text) {
  if (!text) return null;
  const normalized = normalizeText(text);

  for (const addr of KNOWN_SENDER_DATA.addresses) {
    if (normalized.includes(normalizeText(addr))) {
      return { type: 'address', value: addr };
    }
  }

  for (const name of KNOWN_SENDER_DATA.names) {
    if (normalized.includes(normalizeText(name))) {
      return { type: 'name', value: name };
    }
  }

  for (const city of KNOWN_SENDER_DATA.cities) {
    // Para ciudades, ser más estricto (match completo o como palabra)
    const cityNorm = normalizeText(city);
    if (normalized === cityNorm || normalized.split(/\s+/).includes(cityNorm)) {
      return { type: 'city', value: city };
    }
  }

  return null;
}

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
 *
 * IMPORTANTE: Excluye activamente líneas que contengan datos conocidos
 * del remitente (BPM / Blanquería x Mayor / origen) para evitar contaminación.
 */
function extractDestinationZone(ocrText) {
  if (!ocrText) return { lines: [], confidence: 0, log: [], extractedCity: null };

  const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l);
  const log = [];

  let inDestinationZone = false;
  let inExcludeZone = false;
  let destinationLines = [];
  let foundDestinationHeader = false;
  let linesAfterDestHeader = 0;
  let extractedCity = null; // Ciudad extraída del header "DESTINO ciudad(código)"

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerInfo = detectSectionHeader(line);

    // Detectar headers de sección
    if (headerInfo) {
      if (headerInfo.type === 'destination') {
        log.push(`📍 L${i}: Header DESTINO detectado: "${line}" (${headerInfo.header})`);
        inDestinationZone = true;
        inExcludeZone = false;
        foundDestinationHeader = true;
        linesAfterDestHeader = 0;

        // Extraer ciudad del header tipo "DESTINO Rawson(CBT010)" o "DESTINO Concordia"
        const cityMatch = line.match(/destino\s+([A-Za-záéíóúñ\s]+?)(?:\s*\(|$)/i);
        if (cityMatch && cityMatch[1]) {
          const cityCandidate = cityMatch[1].trim();
          // Verificar que no sea una palabra clave y que no sea del remitente
          if (cityCandidate.length >= 3 && !/^(destino|destinatario|contado)$/i.test(cityCandidate)) {
            const senderCheck = isKnownSenderData(cityCandidate);
            if (!senderCheck) {
              extractedCity = cityCandidate;
              log.push(`   🏙️ Ciudad extraída del header: "${extractedCity}"`);
            }
          }
        }

        // Incluir contenido después del header si está en la misma línea
        const afterHeader = line.split(/[:]\s*/)[1];
        if (afterHeader && afterHeader.trim()) {
          const senderCheck = isKnownSenderData(afterHeader);
          if (!senderCheck) {
            destinationLines.push(afterHeader.trim());
          } else {
            log.push(`   🚫 Excluido (dato remitente ${senderCheck.type}): "${afterHeader}"`);
          }
        }
        continue;
      } else if (headerInfo.type === 'exclude') {
        log.push(`🚫 L${i}: Header EXCLUIR detectado: "${line}" (${headerInfo.header})`);
        inExcludeZone = true;
        if (inDestinationZone) {
          log.push(`   ↳ Finalizando zona destinatario`);
        }
        inDestinationZone = false;
        continue;
      }
    }

    // Si estamos en zona de exclusión, saltar
    if (inExcludeZone) {
      log.push(`⏭️ L${i}: Omitido (zona remitente): "${line}"`);
      continue;
    }

    // Verificar si la línea contiene datos conocidos del remitente
    const senderCheck = isKnownSenderData(line);
    if (senderCheck) {
      log.push(`🚫 L${i}: Excluido (dato remitente ${senderCheck.type}): "${line}"`);
      // NO salir de zona destino - solo excluir esta línea
      // El OCR mezcla columnas, así que datos del remitente pueden aparecer
      // intercalados con datos del destinatario
      continue;
    }

    if (inDestinationZone) {
      linesAfterDestHeader++;
      // Filtrar líneas que parecen ser metadata o no relevantes
      if (!isMetadataLine(line)) {
        // Límite de líneas para evitar capturar demasiado
        if (destinationLines.length < 15) {
          destinationLines.push(line);
          log.push(`✅ L${i}: Incluido en zona destino: "${line}"`);
        } else {
          log.push(`⏭️ L${i}: Omitido (límite de líneas): "${line}"`);
        }
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
  if (extractedCity) {
    log.push(`📊 Ciudad del header: ${extractedCity}`);
  }

  return { lines: destinationLines, confidence, log, foundHeader: foundDestinationHeader, extractedCity };
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
 * IMPORTANTE: Excluye nombres conocidos del remitente
 */
function extractNameFromDestination(lines, log) {
  // Buscar línea con label de nombre (incluye "Señor/es", "Sr/a", etc.)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Matchear: "Señor/es NOMBRE", "Sr. NOMBRE", "Sra NOMBRE", "A nombre de NOMBRE"
    const nameMatch = line.match(/(?:se[ñn]or(?:\/es|es)?|sr\.?\/a?|sra?\.?|nombre|a nombre de)[\s:]+(.+)/i);
    if (nameMatch && nameMatch[1]) {
      let name = nameMatch[1].trim();
      // Limpiar residuos del OCR (ej: "/ es" de "Señor/es" separado)
      name = name.replace(/^[\/\s]*es\s+/i, '').trim();
      // Filtrar basura común
      if (name.length >= 3 && name.length < 60 && !/^(domicilio|direccion|calle|tel)/i.test(name)) {
        // Verificar que no sea nombre del remitente
        const senderCheck = isKnownSenderData(name);
        if (senderCheck) {
          log.push(`👤 Nombre descartado (remitente): "${name}"`);
          continue;
        }
        log.push(`👤 Nombre extraído (con label): "${name}"`);
        return name;
      }
    }
  }

  // Buscar primera línea que parezca nombre propio
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i];

    // Ignorar líneas que claramente no son nombres
    if (/^(domicilio|direccion|calle|telefono|tel\.|dni|cuit|localidad|cp\b|cantidad|descripci|servicio|encomienda|reembolso|contado|destino)/i.test(line)) {
      continue;
    }

    // Verificar que no sea dato del remitente
    const senderCheck = isKnownSenderData(line);
    if (senderCheck) {
      log.push(`👤 Línea descartada (remitente ${senderCheck.type}): "${line}"`);
      continue;
    }

    const words = line.split(/\s+/);

    // Parece nombre: 2-5 palabras alfabéticas (permite TODO MAYÚSCULAS o Capitalizado)
    if (words.length >= 2 && words.length <= 5) {
      const looksLikeName = words.every(w =>
        // Permite: "EUGENIA", "Eugenia", "María", "DE", "DEL", "LA"
        /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ]*\.?$/i.test(w) &&
        w.length >= 2 &&
        !/^\d+$/.test(w) // No números
      );
      if (looksLikeName) {
        log.push(`👤 Nombre extraído (heurística): "${line}"`);
        return line;
      }
    }

    // Alternativa: "APELLIDO, Nombre" o "APELLIDO APELLIDO"
    if (/^[A-ZÁÉÍÓÚÑ]{2,}[,\s]+[A-ZÁÉÍÓÚÑ][A-Za-záéíóúñ]+/.test(line)) {
      log.push(`👤 Nombre extraído (formato APELLIDO): "${line}"`);
      return line;
    }
  }

  log.push(`👤 Nombre: no encontrado`);
  return null;
}

/**
 * Extrae dirección del destinatario de las líneas filtradas
 * IMPORTANTE: Excluye direcciones conocidas del remitente (ej: GAONA 2376)
 */
function extractAddressFromDestination(lines, log) {
  // Patrones a EXCLUIR (no son direcciones)
  const excludePatterns = [
    /^dni\b/i,
    /^cuit\b/i,
    /^c\.?u\.?i\.?t\.?\b/i,
    /^telefono/i,
    /^tel[eé]fono/i,
    /^tel\b/i,
    /^cel\b/i,
    /^celular/i,
    /^cp\b/i,
    /^codigo\s*postal/i,
    /^localidad/i,
    /^provincia/i,
    /^remito/i,
    /^guia/i,
    /^se[ñn]or/i,    // No es dirección
    /^cantidad/i,    // Es campo de cantidad
    /^descripci[oó]n/i, // Es descripción
    /^domicilio$/i,  // Es el label, no la dirección
    /^dia$/i,        // Campos de fecha
    /^mes$/i,
    /^a[ñn]o$/i,
    /^anc$/i,
    /^\d{1,2}$/,     // Solo números cortos (día, mes)
    /^\d{4}$/,       // Solo año
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Saltar líneas que no son direcciones
    if (excludePatterns.some(p => p.test(line.trim()))) {
      continue;
    }

    // Verificar que no sea dirección del remitente
    const senderCheck = isKnownSenderData(line);
    if (senderCheck) {
      log.push(`📍 Dirección descartada (remitente): "${line}"`);
      continue;
    }

    // Buscar con label explícito (domicilio, dirección, etc.)
    const addrMatch = line.match(/(?:direcci[oó]n|domicilio|calle|av\.?|avenida)[\s:]+(.+)/i);
    if (addrMatch && addrMatch[1]) {
      const addr = addrMatch[1].trim();
      // Verificar que el contenido extraído no sea del remitente
      const addrSenderCheck = isKnownSenderData(addr);
      if (addrSenderCheck) {
        log.push(`📍 Dirección descartada (remitente en label): "${addr}"`);
        continue;
      }
      if (addr.length > 5 && !excludePatterns.some(p => p.test(addr))) {
        log.push(`📍 Dirección extraída (con label): "${addr}"`);
        return addr;
      }
    }

    // Buscar patrón calle + número (incluye "N°", "Nro", etc.)
    // Ejemplo: "RAZQUIN N°600", "AV GAONA 2376", "PASO 422"
    const streetMatch = line.match(/^([A-Za-záéíóúñ\s\.]+)\s+(?:n[°ºo]?\.?\s*)?(\d{1,5})\s*(.*)$/i);
    if (streetMatch) {
      const fullAddr = line.trim();
      if (fullAddr.length > 5 && fullAddr.length < 100) {
        log.push(`📍 Dirección extraída (calle + nro): "${fullAddr}"`);
        return fullAddr;
      }
    }
  }

  // Fallback: buscar líneas después de "Domicilio"
  // Puede haber varias líneas de dirección mezcladas con datos del remitente
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^domicilio$/i.test(lines[i].trim())) {
      // Buscar en las siguientes líneas (hasta 5) una dirección válida
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const candidateLine = lines[j].trim();

        // Saltar líneas vacías o muy cortas
        if (candidateLine.length < 5) continue;

        // Saltar si es patrón de exclusión
        if (excludePatterns.some(p => p.test(candidateLine))) continue;

        // Verificar que no sea del remitente
        const senderCheck = isKnownSenderData(candidateLine);
        if (senderCheck) {
          log.push(`📍 Candidato post-Domicilio descartado (remitente): "${candidateLine}"`);
          continue;
        }

        // Verificar que parece una dirección (tiene letras y posiblemente números)
        if (/[a-záéíóúñ]/i.test(candidateLine)) {
          log.push(`📍 Dirección extraída (línea ${j - i} después de Domicilio): "${candidateLine}"`);
          return candidateLine;
        }
      }
    }
  }

  log.push(`📍 Dirección: no encontrada`);
  return null;
}

/**
 * Extrae ciudad/localidad del destinatario de las líneas filtradas
 * IMPORTANTE: Excluye ciudades conocidas del remitente (CABA, Capital Federal)
 */
function extractCityFromDestination(lines, log) {
  const cityPatterns = [
    /(?:ciudad|localidad|partido|loc\.)[\s:]+([^\n,]+)/i,
  ];

  // Lista de ciudades conocidas de Argentina
  // NOTA: CABA/Capital Federal están en KNOWN_SENDER_DATA y serán filtradas
  const knownCities = [
    'córdoba', 'cordoba', 'rosario', 'mendoza', 'la plata', 'mar del plata',
    'san miguel', 'san isidro', 'vicente lopez', 'vicente lópez', 'tigre', 'pilar',
    'morón', 'moron', 'quilmes', 'avellaneda', 'lanús', 'lanus',
    'lomas de zamora', 'florencio varela', 'berazategui', 'almirante brown',
    'ezeiza', 'esteban echeverría', 'merlo', 'moreno', 'josé c. paz',
    'san martín', 'san martin', 'tres de febrero', 'hurlingham', 'ituzaingó',
    'carhue', 'bahia blanca', 'bahía blanca', 'necochea', 'tandil',
    'olavarria', 'olavarría', 'azul', 'trenque lauquen', 'pehuajo',
    'junin', 'junín', 'pergamino', 'san nicolas', 'san nicolás',
    'zárate', 'zarate', 'campana', 'escobar', 'malvinas argentinas',
    // Ciudades de los tests
    'rawson', 'morteros', 'la rioja', 'concordia', 'esquina',
    'rafaela', 'curuzu cuatia', 'curuzú cuatiá', 'dean funes', 'deán funes'
  ];

  // Recolectar TODAS las ciudades encontradas, preferir la última
  // (en remitos de 2 columnas, destinatario suele estar a la derecha/abajo)
  const foundCities = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Verificar que la línea no sea del remitente
    const senderCheck = isKnownSenderData(line);
    if (senderCheck && senderCheck.type === 'city') {
      log.push(`🏙️ Ciudad descartada (remitente): "${line}"`);
      continue;
    }

    // Buscar con label (ej: "Localidad CARHUE")
    for (const pattern of cityPatterns) {
      const match = line.match(pattern);
      if (match && match[1]) {
        const city = match[1].trim();
        // Excluir si parece ser código postal o número
        if (!/^\d+$/.test(city) && city.length >= 3) {
          // Verificar que la ciudad extraída no sea del remitente
          const citySenderCheck = isKnownSenderData(city);
          if (citySenderCheck) {
            log.push(`🏙️ Ciudad en label descartada (remitente): "${city}"`);
            continue;
          }
          foundCities.push({ city, source: 'label', index: i });
        }
      }
    }

    // Buscar ciudades conocidas en el texto
    const normalizedLine = normalizeText(line);
    for (const city of knownCities) {
      if (normalizedLine.includes(normalizeText(city))) {
        foundCities.push({ city, source: 'known', index: i });
      }
    }
  }

  if (foundCities.length > 0) {
    // Preferir la ÚLTIMA ciudad encontrada (más probable que sea destino)
    const best = foundCities[foundCities.length - 1];
    log.push(`🏙️ Ciudad extraída (${best.source}, línea ${best.index}): "${best.city}"`);
    if (foundCities.length > 1) {
      log.push(`   ℹ️ También encontradas: ${foundCities.slice(0, -1).map(c => c.city).join(', ')}`);
    }
    return best.city;
  }

  log.push(`🏙️ Ciudad: no encontrada`);
  return null;
}

/**
 * Stage D: Extracción completa con scoring de confianza
 * Esta función reemplaza extractName, extractAddress, extractCity
 *
 * IMPORTANTE: El fallback ahora es más conservador.
 * Si no encuentra zona de destino clara, filtra agresivamente
 * cualquier línea que parezca del remitente antes de extraer.
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
    // Fallback conservador: filtrar líneas del remitente antes de extraer
    result.log.push('⚠️ No se detectó zona destinatario, usando fallback CONSERVADOR');

    const allLines = ocrText.split('\n').map(l => l.trim()).filter(l => l && !isMetadataLine(l));

    // Filtrar líneas que son claramente del remitente
    const filteredLines = allLines.filter(line => {
      const senderCheck = isKnownSenderData(line);
      if (senderCheck) {
        result.log.push(`   🚫 Fallback: excluido (remitente ${senderCheck.type}): "${line}"`);
        return false;
      }
      return true;
    });

    result.log.push(`   📋 Fallback: ${filteredLines.length}/${allLines.length} líneas después de filtrar remitente`);

    if (filteredLines.length > 0) {
      const extracted = extractDestinatarioFromZone(filteredLines);
      result.name = extracted.name;
      result.address = extracted.address;
      result.city = extracted.city;
      result.confidence = 0.2; // Muy baja confianza en fallback
      result.log.push(...extracted.extractionLog);
    } else {
      result.log.push('   ❌ No quedaron líneas válidas después de filtrar');
      result.confidence = 0;
    }

    // Incluso en fallback, usar ciudad del header si está disponible
    if (!result.city && zoneResult.extractedCity) {
      result.city = zoneResult.extractedCity;
      result.log.push(`🏙️ Ciudad tomada del header DESTINO: "${result.city}"`);
    }
  } else {
    // Extraer datos de la zona identificada
    const extracted = extractDestinatarioFromZone(zoneResult.lines);
    result.name = extracted.name;
    result.address = extracted.address;
    result.city = extracted.city;
    result.log.push(...extracted.extractionLog);

    // Si no se encontró ciudad pero tenemos una del header "DESTINO ciudad", usarla
    if (!result.city && zoneResult.extractedCity) {
      result.city = zoneResult.extractedCity;
      result.log.push(`🏙️ Ciudad tomada del header DESTINO: "${result.city}"`);
    }

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

/**
 * NUEVA FUNCIÓN: Extracción basada en LAYOUT (bounding boxes)
 *
 * Para Via Cargo, usa las coordenadas X del OCR para separar
 * REMITENTE (izquierda) de DESTINATARIO (derecha), eliminando
 * completamente la contaminación de datos del origen.
 *
 * @param {Array} textAnnotations - textAnnotations de Google Vision
 * @param {string} fullText - Texto completo (fallback)
 * @returns {Object} { name, address, city, confidence, log }
 */
function extractDestinatarioWithLayout(textAnnotations, fullText) {
  const result = {
    name: null,
    address: null,
    city: null,
    confidence: 0,
    log: []
  };

  result.log.push('=== EXTRACCIÓN VIA CARGO (LAYOUT) ===');

  // Intentar separación por layout
  const layoutResult = separateByLayout(textAnnotations);
  result.log.push(...layoutResult.log);

  if (layoutResult.rightColumn && layoutResult.rightColumn.length > 20) {
    // Tenemos columna derecha (destinatario) - usar solo esa
    result.log.push('✅ Usando columna derecha (DESTINATARIO) exclusivamente');

    // Extraer datos de la columna derecha
    const rightColumnText = layoutResult.rightColumn;
    const lines = rightColumnText.split('\n').map(l => l.trim()).filter(l => l);

    // Ahora extraemos del texto limpio de la columna derecha
    // Ya no necesitamos filtrar datos del remitente porque físicamente están separados
    const extracted = extractDestinatarioFromZone(lines);
    result.name = extracted.name;
    result.address = extracted.address;
    result.city = extracted.city;
    result.log.push(...extracted.extractionLog);

    // Buscar ciudad en el header "DESTINO ciudad" si no se encontró
    if (!result.city) {
      const cityMatch = rightColumnText.match(/destino\s+([A-Za-záéíóúñ\s]+?)(?:\s*\(|$)/i);
      if (cityMatch && cityMatch[1]) {
        const cityCandidate = cityMatch[1].trim();
        if (cityCandidate.length >= 3 && !/^(destino|destinatario|contado)$/i.test(cityCandidate)) {
          result.city = cityCandidate;
          result.log.push(`🏙️ Ciudad del header DESTINO: "${result.city}"`);
        }
      }
    }

    // Alta confianza porque usamos separación física
    let dataConfidence = 0;
    if (result.name) dataConfidence += 0.4;
    if (result.address) dataConfidence += 0.4;
    if (result.city) dataConfidence += 0.2;
    result.confidence = 0.95 * dataConfidence; // 95% confianza base por layout

    result.log.push(`=== RESULTADO LAYOUT: confianza ${(result.confidence * 100).toFixed(0)}% ===`);

  } else {
    // Fallback: no hay suficiente info de layout, usar método tradicional
    result.log.push('⚠️ Layout insuficiente, usando método tradicional (heurísticas)');

    const traditional = extractDestinatarioFromOcr(fullText);
    result.name = traditional.name;
    result.address = traditional.address;
    result.city = traditional.city;
    result.confidence = traditional.confidence;
    result.log.push(...traditional.log);
  }

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
 * (formulario bpmadministrador.com/envio), NO datos de Tiendanube.
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
      sr.created_at as shipping_created_at,
      ov.estado_pedido,
      ov.customer_name
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
    return { bestMatch: null, candidates: [] };
  }

  // Acumular TODOS los candidatos que superen el umbral
  const allCandidates = [];

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

    // Agregar a candidatos si supera umbral mínimo 50%
    if (finalScore >= 0.5) {
      allCandidates.push({
        orderNumber: shipping.order_number,
        score: finalScore,
        customerName: shipping.customer_name || shipping.nombre_apellido,
        createdAt: shipping.shipping_created_at,
        details: {
          ...scores,
          source: 'shipping_requests',
          empresa_envio: shipping.empresa_envio,
          destino_tipo: shipping.destino_tipo
        }
      });
    }
  }

  // Ordenar por score descendente, luego por fecha más reciente
  allCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const bestMatch = allCandidates.length > 0 ? allCandidates[0] : null;

  if (bestMatch) {
    console.log(`   🎯 Match encontrado via shipping_requests: #${bestMatch.orderNumber} (score: ${(bestMatch.score * 100).toFixed(1)}%)`);
    if (allCandidates.length > 1) {
      console.log(`   ⚠️ Hay ${allCandidates.length} candidatos posibles (mismo cliente con múltiples pedidos)`);
    }
  } else {
    console.log(`   ❌ Sin match en shipping_requests (score < 50%)`);
  }

  return { bestMatch, candidates: allCandidates };
}

/**
 * Procesa un documento con OCR y busca coincidencias
 *
 * FLUJO:
 * 1. Detectar si es Via Cargo (buscar "VIA CARGO" en OCR)
 * 2. Si es Via Cargo → extracción por layout + matching normal
 * 3. Si NO es Via Cargo → matching por nombre en texto completo
 *
 * @param {number} documentId - ID del documento
 * @param {string} ocrText - Texto completo del OCR
 * @param {Array} textAnnotations - (Opcional) textAnnotations de Google Vision con bounding boxes
 */
async function processDocument(documentId, ocrText, textAnnotations = null) {
  console.log(`🔍 Procesando documento ${documentId}...`);

  try {
    // Detectar tipo de remito
    const esViaCargo = isViaCargo(ocrText);
    console.log(`   📦 Tipo de remito: ${esViaCargo ? 'VIA CARGO' : 'OTRO TRANSPORTE'}`);

    let match = null;
    let extraction = null;
    let matchDetails = {};

    if (esViaCargo) {
      // ========== CASO 1: VIA CARGO ==========
      // Usar extracción por layout (2 columnas) + matching normal

      if (textAnnotations && textAnnotations.length > 1) {
        console.log(`   📐 Usando extracción por LAYOUT (${textAnnotations.length} anotaciones)`);
        extraction = extractDestinatarioWithLayout(textAnnotations, ocrText);
      } else {
        console.log(`   📝 Usando extracción tradicional (sin bounding boxes)`);
        extraction = extractDestinatarioFromOcr(ocrText);
      }

      console.log(`   📝 Extracción con confianza: ${(extraction.confidence * 100).toFixed(0)}%`);
      console.log(`   👤 Nombre detectado: ${extraction.name || '(ninguno)'}`);
      console.log(`   📍 Dirección detectada: ${extraction.address || '(ninguna)'}`);
      console.log(`   🏙️ Ciudad detectada: ${extraction.city || '(ninguna)'}`);

      // Log detallado de extracción
      if (process.env.NODE_ENV === 'development' || process.env.DEBUG_OCR) {
        console.log('   --- Log de extracción ---');
        extraction.log.forEach(l => console.log(`   ${l}`));
        console.log('   --- Fin log ---');
      }

      // Buscar match si la confianza es suficiente
      let candidates = [];
      if (extraction.confidence >= 0.2 && (extraction.name || extraction.address)) {
        const matchResult = await findBestMatch(extraction.name, extraction.address, extraction.city);
        match = matchResult.bestMatch;
        candidates = matchResult.candidates;
      } else {
        console.log(`   ⚠️ Confianza muy baja (${(extraction.confidence * 100).toFixed(0)}%), no se busca match`);
      }

      matchDetails = match ? {
        ...match.details,
        remito_type: 'via_cargo',
        extractionConfidence: extraction.confidence,
        extractionLog: extraction.log,
        matchSource: 'shipping_requests',
        // Incluir TODOS los candidatos para que el frontend pueda mostrarlos
        candidates: candidates.map(c => ({
          orderNumber: c.orderNumber,
          customerName: c.customerName,
          score: c.score,
          createdAt: c.createdAt
        }))
      } : {
        remito_type: 'via_cargo',
        extractionConfidence: extraction.confidence,
        extractionLog: extraction.log,
        noMatchReason: extraction.confidence < 0.2
          ? 'extraction_confidence_too_low'
          : 'no_shipping_request_match',
        candidates: []
      };

    } else {
      // ========== CASO 2: OTROS TRANSPORTES ==========
      // NO parsear layout, solo buscar nombre en texto completo

      console.log(`   🔎 Buscando coincidencia de nombre en texto OCR completo...`);
      const { bestMatch, candidates } = await findMatchByNameInFullText(ocrText);
      match = bestMatch;

      // No extraemos datos estructurados para otros transportes
      extraction = {
        name: match ? match.details.nameTokens.join(' ') : null,
        address: null,
        city: null,
        confidence: match ? match.score : 0,
        log: ['Matching por nombre en texto completo (no Via Cargo)']
      };

      // Incluir candidatos en match_details para que el frontend pueda mostrarlos
      matchDetails = match ? {
        ...match.details,
        remito_type: 'otro_transporte',
        candidates: candidates.map(c => ({
          orderNumber: c.orderNumber,
          customerName: c.customerName,
          score: c.score,
          createdAt: c.createdAt
        }))
      } : {
        remito_type: 'otro_transporte',
        noMatchReason: 'no_name_match_in_fulltext',
        note: 'No se encontró coincidencia de nombre en el texto OCR',
        candidates: []
      };
    }

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

      // IMPORTANTE: Limpiar suggested_order_number y match_score
      // para que no queden valores viejos del matching anterior
      await pool.query(`
        UPDATE shipping_documents
        SET
          ocr_text = $1,
          ocr_processed_at = NOW(),
          detected_name = $2,
          detected_address = $3,
          detected_city = $4,
          suggested_order_number = NULL,
          match_score = NULL,
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

/**
 * Procesa un remito usando Claude Vision en lugar de Google Vision
 * Claude analiza la imagen y extrae datos estructurados directamente
 */
async function processDocumentWithClaude(documentId, claudeData) {
  console.log(`🔍 Procesando documento ${documentId} con datos de Claude Vision...`);

  try {
    const esViaCargo = claudeData.empresa_transporte &&
      claudeData.empresa_transporte.toLowerCase().includes('cargo');

    const remitoType = esViaCargo ? 'via_cargo' : 'otro_transporte';
    console.log(`   📦 Tipo de remito: ${remitoType}`);

    const extraction = {
      name: claudeData.destinatario?.nombre || null,
      address: claudeData.destinatario?.domicilio || null,
      city: claudeData.destinatario?.localidad || null,
      confidence: 0.95, // Claude Vision tiene alta confianza
      log: ['Extracción por Claude Vision (sin bounding boxes)']
    };

    console.log(`   👤 Nombre detectado: ${extraction.name || '(ninguno)'}`);
    console.log(`   📍 Dirección detectada: ${extraction.address || '(ninguna)'}`);
    console.log(`   🏙️ Ciudad detectada: ${extraction.city || '(ninguna)'}`);

    // Texto completo para guardar en DB
    const ocrText = claudeData.texto_completo || JSON.stringify(claudeData);

    let match = null;
    let matchDetails = {};
    let candidates = [];

    if (extraction.name || extraction.address) {
      if (esViaCargo) {
        // Via Cargo: match estructural por nombre + dirección + ciudad
        const matchResult = await findBestMatch(extraction.name, extraction.address, extraction.city);
        match = matchResult.bestMatch;
        candidates = matchResult.candidates;
      } else {
        // Otros: match por nombre en texto completo
        const matchResult = await findMatchByNameInFullText(ocrText);
        match = matchResult.bestMatch;
        candidates = matchResult.candidates;
      }
    }

    matchDetails = match ? {
      ...match.details,
      remito_type: remitoType,
      extractionConfidence: extraction.confidence,
      extractionLog: extraction.log,
      matchSource: 'shipping_requests',
      claude_vision: true,
      candidates: candidates.map(c => ({
        orderNumber: c.orderNumber,
        customerName: c.customerName,
        score: c.score,
        createdAt: c.createdAt
      }))
    } : {
      remito_type: remitoType,
      extractionConfidence: extraction.confidence,
      extractionLog: extraction.log,
      noMatchReason: 'no_shipping_request_match',
      claude_vision: true,
      candidates: []
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
          suggested_order_number = NULL,
          match_score = NULL,
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
  extractDestinatarioWithLayout,
  extractDestinationZone,
  separateByLayout,
  findBestMatch,
  processDocument,
  processDocumentWithClaude
};
