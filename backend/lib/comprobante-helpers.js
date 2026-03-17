/**
 * Comprobante Helper Functions
 *
 * Funciones compartidas entre el endpoint de upload y el OCR worker.
 * Extraidas de index.js para evitar duplicacion.
 */

const pool = require('../db');
const sharp = require('sharp');
const fs = require('fs');
const { calcularEstadoCuenta, TOLERANCIA } = require('../utils/calcularEstadoCuenta');
const { hashText } = require('../hash');

/* =====================================================
   UTIL — WATERMARK RECEIPT
   Aplica marca de agua al comprobante con datos del pedido.
===================================================== */
async function watermarkReceipt(filePath, { id, orderNumber }) {
  const image = sharp(filePath);
  const metadata = await image.metadata();

  const width = metadata.width || 800;
  const fontSize = Math.max(18, Math.round(width * 0.03));
  const padding = Math.round(fontSize * 0.6);
  const lineHeight = Math.round(fontSize * 1.3);

  const lines = [
    `ID: ${id}`,
    `Pedido: ${orderNumber}`
  ];

  const textWidth = Math.round(fontSize * 10);
  const textHeight = lines.length * lineHeight + padding * 2;

  const svgOverlay = `
    <svg width="${textWidth}" height="${textHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${textWidth}" height="${textHeight}"
            fill="rgba(0,0,0,0.7)" rx="4" ry="4"/>
      ${lines.map((line, i) => `
        <text x="${padding}" y="${padding + fontSize + i * lineHeight}"
              font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="${fontSize}"
              fill="white" font-weight="bold">${line}</text>
      `).join('')}
    </svg>
  `;

  await sharp(filePath)
    .composite([{
      input: Buffer.from(svgOverlay),
      top: padding,
      left: padding
    }])
    .toFile(filePath + '.tmp');

  await fs.promises.rename(filePath + '.tmp', filePath);

  console.log('🏷️ Watermark aplicado:', filePath);
}

/* =====================================================
   UTIL — DETECTAR MONTO DESDE OCR
===================================================== */
function detectarMontoDesdeOCR(texto) {
  if (!texto) return { monto: null, moneda: null };

  const textoNormalizado = texto
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\x00-\x7F]/g, '');

  const palabrasClaveFuertes = ['importe', 'monto', 'total', '$', 'ars', 'pesos'];
  const palabrasTrampa = ['cbu', 'cvu', 'cuit', 'cuil', 'operacion', 'referencia', 'codigo', 'alias'];

  // Soporta: $106.550,00 | $106.550 | 106550.00 | 106550,00 | $106550
  // Orden: patron largo primero para que no sea consumido parcialmente por el corto
  const regexMonto = /\$?\s?\d{4,}(?:[.,]\d{2})?|\$?\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/g;
  const matches = textoNormalizado.match(regexMonto);

  if (!matches) return { monto: null, moneda: null };

  let mejorMonto = null;
  let mejorPuntaje = -1;

  for (const match of matches) {
    // Detectar formato: si tiene punto de miles (1-3 digitos, punto, 3 digitos) vs punto decimal (muchos digitos, punto, 2 digitos)
    const trimmed = match.replace('$', '').trim();
    let valorNumerico;

    if (/^\d{1,3}(\.\d{3})+(,\d{2})?$/.test(trimmed)) {
      // Formato AR: 106.550 o 106.550,00 (punto = miles, coma = decimales)
      valorNumerico = Number(trimmed.replace(/\./g, '').replace(',', '.'));
    } else if (/^\d{4,}[.,]\d{2}$/.test(trimmed)) {
      // Formato sin separador de miles: 106550.00 o 106550,00
      valorNumerico = Number(trimmed.replace(',', '.'));
    } else {
      // Numero plano: 106550
      valorNumerico = Number(trimmed.replace(/\./g, '').replace(',', '.'));
    }

    if (isNaN(valorNumerico)) continue;
    if (valorNumerico < 1000) continue;

    // Descartar numeros que parecen anos, codigos largos, CBU, CUIT
    if (valorNumerico >= 2020 && valorNumerico <= 2030) continue;
    if (valorNumerico > 99999999 && !match.includes('.') && !match.includes(',')) continue;

    let puntaje = 0;

    const idx = textoNormalizado.indexOf(match);
    const contexto = textoNormalizado.substring(
      Math.max(0, idx - 50),
      idx + 50
    );

    if (match.includes('$')) puntaje += 3;
    // "importe" y "monto" son senales muy fuertes
    if (contexto.includes('importe') || contexto.includes('monto')) puntaje += 5;
    if (palabrasClaveFuertes.some(p => contexto.includes(p))) puntaje += 2;
    if (!palabrasTrampa.some(p => contexto.includes(p))) puntaje += 2;
    // Bonus por tener decimales (formato monetario)
    if (match.includes(',') || /\.\d{2}$/.test(match.trim())) puntaje += 2;

    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejorMonto = match;
    }
  }

  if (!mejorMonto) return { monto: null, moneda: null };

  // Parsear con la misma logica de deteccion de formato
  const trimmedFinal = mejorMonto.replace('$', '').trim();
  let montoNumero;

  if (/^\d{1,3}(\.\d{3})+(,\d{2})?$/.test(trimmedFinal)) {
    montoNumero = Number(trimmedFinal.replace(/\./g, '').replace(',', '.'));
  } else if (/^\d{4,}[.,]\d{2}$/.test(trimmedFinal)) {
    montoNumero = Number(trimmedFinal.replace(',', '.'));
  } else {
    montoNumero = Number(trimmedFinal.replace(/\./g, '').replace(',', '.'));
  }

  if (isNaN(montoNumero)) return { monto: null, moneda: null };

  return { monto: montoNumero, moneda: 'ARS' };
}

/* =====================================================
   UTIL — VALIDAR QUE SEA COMPROBANTE REAL
===================================================== */
function validarComprobante(textoOcr) {
  const mensajeError =
    'El archivo no parece ser un comprobante válido. Contactate con nosotros por WhatsApp para que te ayudemos.';

  if (!textoOcr) {
    throw new Error(mensajeError);
  }

  const texto = textoOcr.toLowerCase().replace(/\s+/g, ' ');

  const keywords = [
    'transferencia',
    'comprobante',
    'pago',
    'importe',
    'total',
    'fecha',
    'operacion',
    'referencia',
    'cbu',
    'cvu',
    'alias'
  ];

  const esValido =
    texto.length >= 30 &&
    keywords.some(k => texto.includes(k));

  if (!esValido) {
    throw new Error(mensajeError);
  }
}

/* =====================================================
   UTIL — NORMALIZAR TEXTO (quitar tildes, lowercase, trim)
===================================================== */
function normalizeText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/\s+/g, ' ')            // colapsar espacios
    .trim();
}

/* =====================================================
   UTIL — EXTRAER CUENTA DESTINO DEL OCR (ROBUSTO)
===================================================== */
function extractDestinationAccount(textoOcr) {
  const texto = textoOcr.replace(/\r/g, '\n');
  const lines = texto.split('\n').map(l => l.trim()).filter(Boolean);

  let alias = null;
  let cbu = null;
  let cvu = null;
  let titular = null;
  const nombres = []; // Guardar todos los posibles nombres encontrados

  // DEBUG: Buscar secuencias numericas largas en el OCR
  const digitSequences = texto.match(/\d[\d\s\-\.]{15,30}\d/g) || [];
  console.log('🔢 Secuencias numéricas encontradas:', digitSequences.map(s => {
    const clean = s.replace(/\D/g, '');
    return `"${s}" → ${clean} (${clean.length} dígitos)`;
  }));

  // Keywords que indican seccion destino (case insensitive, sin depender de ":")
  const destinoKeywords = [
    'destinatario', 'destino', 'beneficiario', 'receptor', 'titular',
    'para', 'cuenta destino', 'transferiste a', 'enviaste a', 'le enviaste'
  ];

  // Keywords que indican FIN de seccion destino (NO incluir cuit porque viene despues del nombre)
  const finSeccionKeywords = [
    'origen', 'desde', 'remitente', 'ordenante', 'monto', 'importe',
    'fecha', 'concepto', 'motivo', 'banco'
  ];

  // 1) BUSCAR POR SECCIONES
  let enSeccionDestino = false;
  let lineasDesdeDestino = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    // Detectar INICIO de seccion destino
    const isDestinoLine = destinoKeywords.some(k => lineLower.includes(k));
    // Detectar INICIO de seccion origen (para ignorar sus datos)
    const isOrigenLine = finSeccionKeywords.some(k => lineLower.includes(k));

    if (isOrigenLine && enSeccionDestino) {
      console.log(`🚫 Fin sección destino en línea ${i}: "${line}"`);
      enSeccionDestino = false;
    }

    if (isDestinoLine) {
      console.log(`✅ Inicio sección destino en línea ${i}: "${line}"`);
      enSeccionDestino = true;
      lineasDesdeDestino = 0;

      // Buscar valor en misma linea despues de ":"
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        const valor = line.substring(colonIndex + 1).trim();
        if (valor.length > 3 && !titular) {
          console.log(`📝 Titular en misma línea: "${valor}"`);
          titular = valor;
        }
      }
      continue;
    }

    // Si estamos en seccion destino, buscar datos (hasta 6 lineas)
    if (enSeccionDestino && lineasDesdeDestino < 6) {
      lineasDesdeDestino++;
      console.log(`  → Línea destino ${lineasDesdeDestino}: "${line}"`);

      // Si es un nombre (letras y espacios, 2+ palabras) - MAS FLEXIBLE
      if (!titular) {
        // Aceptar mayusculas, minusculas, tildes, y que tenga al menos 2 palabras
        const esNombre = /^[A-Za-zÁÉÍÓÚÑáéíóúñ\s]{5,60}$/.test(line) &&
                         line.trim().split(/\s+/).length >= 2 &&
                         !lineLower.includes('cbu') &&
                         !lineLower.includes('cvu') &&
                         !lineLower.includes('alias');
        if (esNombre) {
          console.log(`📝 Titular detectado: "${line}"`);
          titular = line;
        }
      }

      // Si es alias (palabra.palabra.palabra)
      const aliasMatch = line.match(/([a-zA-Z0-9]+\.[a-zA-Z0-9]+\.[a-zA-Z0-9]+)/);
      if (aliasMatch && !alias) {
        console.log(`📝 Alias detectado: "${aliasMatch[1]}"`);
        alias = aliasMatch[1].toUpperCase();
      }

      // Si es CBU/CVU (22 digitos) - SOLO en seccion destino
      const cbuMatch = line.match(/(\d{22})/);
      if (cbuMatch && !cbu && !cvu) {
        console.log(`📝 CBU/CVU detectado en sección destino: "${cbuMatch[1]}"`);
        if (cbuMatch[1].startsWith('000')) cvu = cbuMatch[1];
        else cbu = cbuMatch[1];
      }

      // CBU/CVU con espacios o separadores
      const cbuSeparado = line.replace(/[\s\-\.]/g, '');
      if (cbuSeparado.length === 22 && /^\d+$/.test(cbuSeparado) && !cbu && !cvu) {
        console.log(`📝 CBU/CVU (separado) detectado: "${cbuSeparado}"`);
        if (cbuSeparado.startsWith('000')) cvu = cbuSeparado;
        else cbu = cbuSeparado;
      }
    }
  }

  // 2) FALLBACK GLOBAL - buscar en todo el texto (SOLO si no encontramos en seccion destino)
  const textoCompleto = texto;

  // Alias en cualquier parte (si no lo encontramos en seccion destino)
  if (!alias) {
    const aliasMatches = textoCompleto.match(/[a-zA-Z0-9]+\.[a-zA-Z0-9]+\.[a-zA-Z0-9]+/g);
    if (aliasMatches) {
      console.log(`🔍 Alias por fallback global: "${aliasMatches[0]}"`);
      alias = aliasMatches[0].toUpperCase();
    }
  }

  // CBU/CVU - NO buscar en fallback global porque podria tomar el ORIGEN
  // Solo loguear las secuencias encontradas para debug
  if (!cbu && !cvu) {
    console.log('⚠️ No se encontró CBU/CVU en sección destino (no se busca en texto completo para evitar tomar el origen)');
  }

  // Nombres en mayusculas (posibles titulares)
  if (!titular) {
    for (const line of lines) {
      // Nombre: 2+ palabras en mayusculas, sin numeros, sin keywords
      if (/^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{5,50}$/.test(line) && line.includes(' ')) {
        const lower = line.toLowerCase();
        const esKeyword = [...destinoKeywords, ...finSeccionKeywords, 'alias', 'cbu', 'cvu', 'banco', 'santander', 'nacion', 'galicia'].some(k => lower.includes(k));
        if (!esKeyword) {
          nombres.push(line);
        }
      }
    }
    // Tomar el primer nombre encontrado
    if (nombres.length > 0) {
      titular = nombres[0];
    }
  }

  return { alias, cbu, cvu, titular, nombres };
}

/* =====================================================
   UTIL — VALIDAR CUENTA DESTINO CONTRA DB
===================================================== */
async function isValidDestination(account, textoOcr) {
  const { alias, cbu, cvu, titular, nombres = [] } = account;

  // Obtener TODAS las financieras activas de la DB
  const result = await pool.query(`
    SELECT id, nombre, alias, cbu, titular_principal, palabras_clave
    FROM financieras
    WHERE activa = true
  `);

  if (result.rows.length === 0) {
    // No hay financieras configuradas, permitir todo
    return { valid: true, reason: 'no_financieras_configured' };
  }

  const textoNormalizado = normalizeText(textoOcr);

  for (const fin of result.rows) {
    // 1) Match por ALIAS (exacto)
    if (alias && fin.alias) {
      if (normalizeText(alias) === normalizeText(fin.alias)) {
        return { valid: true, cuenta: fin, matchedBy: 'alias' };
      }
    }

    // 2) Match por CBU
    if (cbu && fin.cbu) {
      if (cbu === fin.cbu) {
        return { valid: true, cuenta: fin, matchedBy: 'cbu' };
      }
    }

    // 3) Match por CVU (si existe en DB)
    if (cvu && fin.cvu) {
      if (cvu === fin.cvu) {
        return { valid: true, cuenta: fin, matchedBy: 'cvu' };
      }
    }

    // 4) Match por TITULAR (flexible - todas las palabras presentes)
    if (fin.titular_principal) {
      const titularDbNorm = normalizeText(fin.titular_principal);
      const palabrasDb = titularDbNorm.split(' ').filter(p => p.length > 2);

      // Verificar contra titular extraido
      if (titular) {
        const titularOcrNorm = normalizeText(titular);
        const todasPresentes = palabrasDb.every(p => titularOcrNorm.includes(p));
        if (todasPresentes) {
          return { valid: true, cuenta: fin, matchedBy: 'titular' };
        }
      }

      // Verificar contra todos los posibles nombres encontrados
      for (const nombre of nombres) {
        const nombreNorm = normalizeText(nombre);
        const todasPresentes = palabrasDb.every(p => nombreNorm.includes(p));
        if (todasPresentes) {
          return { valid: true, cuenta: fin, matchedBy: 'titular_alternativo' };
        }
      }

      // Verificar si el titular de la DB aparece en el texto completo del OCR
      const todasEnTexto = palabrasDb.every(p => textoNormalizado.includes(p));
      if (todasEnTexto) {
        return { valid: true, cuenta: fin, matchedBy: 'titular_en_texto' };
      }
    }

    // 5) Match por PALABRAS CLAVE
    if (fin.palabras_clave && Array.isArray(fin.palabras_clave)) {
      for (const keyword of fin.palabras_clave) {
        if (textoNormalizado.includes(normalizeText(keyword))) {
          return { valid: true, cuenta: fin, matchedBy: 'palabra_clave' };
        }
      }
    }

    // 6) Match por ALIAS en texto completo (por si OCR no lo parseo bien)
    if (fin.alias) {
      const aliasNorm = normalizeText(fin.alias);
      if (textoNormalizado.includes(aliasNorm)) {
        return { valid: true, cuenta: fin, matchedBy: 'alias_en_texto' };
      }
    }
  }

  return { valid: false, reason: 'destination_not_registered', extracted: account };
}

/* =====================================================
   UTIL — DETECTAR FINANCIERA DESDE TEXTO OCR (para backfill)
   Retorna financiera_id si hay match unico, null si hay dudas
===================================================== */
async function detectarFinancieraDesdeOCR(textoOcr) {
  if (!textoOcr) return null;

  const result = await pool.query(`
    SELECT id, nombre, palabras_clave
    FROM financieras
    WHERE activa = true AND palabras_clave IS NOT NULL
  `);

  if (result.rows.length === 0) return null;

  const textoNormalizado = normalizeText(textoOcr);
  const matches = [];

  for (const fin of result.rows) {
    if (!fin.palabras_clave || !Array.isArray(fin.palabras_clave)) continue;

    for (const keyword of fin.palabras_clave) {
      if (textoNormalizado.includes(normalizeText(keyword))) {
        matches.push({ id: fin.id, nombre: fin.nombre, keyword });
        break; // Solo contar una vez por financiera
      }
    }
  }

  // Match unico -> asignar
  if (matches.length === 1) {
    return { financieraId: matches[0].id, nombre: matches[0].nombre, keyword: matches[0].keyword };
  }

  // Multiples matches o ninguno -> no asignar
  if (matches.length > 1) {
    console.log(`⚠️ Múltiples matches de financiera: ${matches.map(m => m.nombre).join(', ')}`);
  }

  return null;
}

module.exports = {
  watermarkReceipt,
  detectarMontoDesdeOCR,
  validarComprobante,
  normalizeText,
  extractDestinationAccount,
  isValidDestination,
  detectarFinancieraDesdeOCR,
  calcularEstadoCuenta,
  TOLERANCIA,
  hashText
};
