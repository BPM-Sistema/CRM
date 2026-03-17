/**
 * Claude Vision Service - Análisis de comprobantes con IA
 *
 * Reemplaza Google Vision OCR + regex/scoring por un solo paso:
 * Claude ve la imagen y devuelve datos estructurados.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const SYSTEM_PROMPT = `Sos un sistema de análisis de comprobantes de pago para una empresa argentina.
Tu tarea es analizar la imagen de un comprobante de transferencia bancaria y extraer datos estructurados.

REGLAS:
- Extraé SOLO lo que ves en la imagen. No inventes datos.
- Los montos son en pesos argentinos (ARS).
- Si un campo no está visible o no podés determinarlo, poné null.
- El CBU tiene exactamente 22 dígitos. El CVU también tiene 22 dígitos y empieza con 000.
- El alias tiene formato palabra.palabra.palabra (con puntos).
- El CUIT/CUIL tiene formato XX-XXXXXXXX-X.
- "Destino" se refiere a la cuenta que RECIBE el dinero (beneficiario).
- Si la imagen NO es un comprobante de pago/transferencia, respondé con {"es_comprobante": false}.

Respondé ÚNICAMENTE con JSON válido, sin markdown ni texto adicional.`;

const USER_PROMPT = `Analizá esta imagen de comprobante y devolvé este JSON exacto:

{
  "es_comprobante": true/false,
  "monto": number o null,
  "banco_origen": "string" o null,
  "fecha": "DD/MM/YYYY" o null,
  "hora": "HH:MM" o null,
  "cbu_destino": "string 22 dígitos" o null,
  "cvu_destino": "string 22 dígitos empezando con 000" o null,
  "alias_destino": "string" o null,
  "titular_destino": "string" o null,
  "cuit_destino": "string" o null,
  "numero_operacion": "string" o null,
  "concepto": "string" o null,
  "texto_completo": "todo el texto visible en la imagen"
}`;

/**
 * Analiza una imagen de comprobante con Claude Vision
 * @param {string} filePath - Ruta al archivo de imagen
 * @returns {Object} Datos estructurados del comprobante
 */
async function analizarComprobante(filePath) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64Image = imageBuffer.toString('base64');

  // Detectar media type
  const ext = path.extname(filePath).toLowerCase();
  const mediaTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  };
  const mediaType = mediaTypes[ext] || 'image/jpeg';

  const startTime = Date.now();

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Image
            }
          },
          {
            type: 'text',
            text: USER_PROMPT
          }
        ]
      }
    ],
    system: SYSTEM_PROMPT
  });

  const latency = Date.now() - startTime;
  const textContent = response.content.find(c => c.type === 'text');

  if (!textContent) {
    throw new Error('Claude Vision no devolvió texto');
  }

  // Parsear JSON de la respuesta
  let datos;
  try {
    // Limpiar posible markdown
    let jsonStr = textContent.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    datos = JSON.parse(jsonStr);
  } catch (e) {
    console.error('❌ Claude Vision respuesta no parseable:', textContent.text);
    throw new Error('Error parseando respuesta de Claude Vision');
  }

  console.log(`🤖 Claude Vision: ${latency}ms | monto: ${datos.monto} | banco: ${datos.banco_origen} | comprobante: ${datos.es_comprobante}`);

  return datos;
}

/**
 * Convierte la respuesta de Claude al formato que espera el flujo existente
 * Compatibilidad con extractDestinationAccount() y detectarMontoDesdeOCR()
 */
function convertirAFormatoLegacy(datos) {
  return {
    // Para reemplazar detectarMontoDesdeOCR
    monto: datos.monto ? Math.round(datos.monto) : 0,
    moneda: 'ARS',

    // Para reemplazar extractDestinationAccount
    cuenta: {
      alias: datos.alias_destino || null,
      cbu: datos.cbu_destino || null,
      cvu: datos.cvu_destino || null,
      titular: datos.titular_destino || null,
      nombres: datos.titular_destino ? [datos.titular_destino] : []
    },

    // Para reemplazar validarComprobante
    esComprobante: datos.es_comprobante === true,

    // Texto completo para hash y compatibilidad
    textoOcr: datos.texto_completo || '',

    // Datos extra que antes no teníamos
    banco: datos.banco_origen,
    fecha: datos.fecha,
    hora: datos.hora,
    cuit: datos.cuit_destino,
    numeroOperacion: datos.numero_operacion,
    concepto: datos.concepto
  };
}

const REMITO_PROMPT = `Analizá este documento de transporte/remito y devolvé ÚNICAMENTE este JSON:

{
  "es_remito": true/false,
  "empresa_transporte": "string (ej: VIA CARGO, ANDREANI, etc)",
  "numero_remito": "string",
  "numero_guia": "string",
  "fecha": "DD/MM/YYYY",
  "numero_pedido": "string (número escrito a mano si hay)",
  "remitente": {
    "nombre": "string",
    "domicilio": "string",
    "telefono": "string",
    "localidad": "string",
    "dni_cuit": "string"
  },
  "destinatario": {
    "nombre": "string",
    "domicilio": "string",
    "telefono": "string",
    "localidad": "string",
    "dni_cuit": "string"
  },
  "peso_kg": number,
  "total": number,
  "reembolso": number o null,
  "texto_completo": "todo el texto visible en la imagen"
}

REGLAS:
- Extraé SOLO lo que ves en la imagen. No inventes datos.
- Si ves BLANQUERIAXMAYOR, BLANQUERIA MAYOR o PET LOVE en el documento, eso es el REMITENTE (quien envía). Todo lo demás es el DESTINATARIO (quien recibe).
- Si hay un número escrito a mano (generalmente arriba a la derecha), es el número de pedido.
- Si la imagen NO es un remito de transporte, respondé con {"es_remito": false}.`;

/**
 * Analiza una imagen de remito con Claude Vision
 * @param {Buffer} imageBuffer - Buffer de la imagen
 * @param {string} mimeType - Tipo MIME (image/jpeg, image/png, application/pdf)
 * @returns {Object} Datos estructurados del remito
 */
async function analizarRemito(imageBuffer, mimeType) {
  const base64Image = imageBuffer.toString('base64');

  // Mapear mime type
  const mediaType = mimeType === 'application/pdf' ? 'image/jpeg' : (mimeType || 'image/jpeg');

  const startTime = Date.now();

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Image
            }
          },
          {
            type: 'text',
            text: REMITO_PROMPT
          }
        ]
      }
    ]
  });

  const latency = Date.now() - startTime;
  const textContent = response.content.find(c => c.type === 'text');

  if (!textContent) {
    throw new Error('Claude Vision no devolvió texto');
  }

  let datos;
  try {
    let jsonStr = textContent.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    datos = JSON.parse(jsonStr);
  } catch (e) {
    console.error('❌ Claude Vision remito respuesta no parseable:', textContent.text);
    throw new Error('Error parseando respuesta de Claude Vision para remito');
  }

  console.log(`🤖 Claude Vision Remito: ${latency}ms | empresa: ${datos.empresa_transporte} | destinatario: ${datos.destinatario?.nombre} | remito: ${datos.es_remito}`);

  return datos;
}

module.exports = {
  analizarComprobante,
  convertirAFormatoLegacy,
  analizarRemito
};
