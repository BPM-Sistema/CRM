/**
 * Lista canónica de las 24 provincias argentinas (IGN) con alias comunes.
 *
 * `name` es el nombre que se muestra en el ranking ("Buenos Aires", "CABA",
 * "Tierra del Fuego", etc.). `aliases` son variantes normalizadas (upper, sin
 * acentos) que el usuario o el form pueden haber tipeado.
 *
 * Para resoluciones que no entren acá, hay un cache (province_aliases) y un
 * fallback a Claude. Ver `services/provinceResolver.js`.
 */

const CANONICAL_PROVINCES = [
  {
    name: 'Buenos Aires',
    aliases: [
      'BUENOS AIRES', 'BS AS', 'BSAS', 'BS.AS', 'BS. AS', 'BA AS',
      'PCIA. BUENOS AIRES', 'PROVINCIA DE BUENOS AIRES', 'PROV BUENOS AIRES',
      'PROV. BUENOS AIRES', 'PROVINCIA BUENOS AIRES',
      'BUE2NOS AIRESA', 'BUENOA AIRES', 'BUENAS AIRES', 'BUENO AIRES',
      'BUENOD AIRES', 'BUE', 'BUENO',
    ],
  },
  {
    name: 'CABA',
    aliases: [
      'CABA', 'C.A.B.A', 'C.A.B.A.', 'CIUDAD AUTONOMA DE BUENOS AIRES',
      'CIUDAD DE BUENOS AIRES', 'CAPITAL FEDERAL', 'CAP FED', 'CAP. FED.',
    ],
  },
  {
    name: 'Catamarca',
    aliases: ['CATAMARCA'],
  },
  {
    name: 'Chaco',
    aliases: ['CHACO', 'EL CHACO'],
  },
  {
    name: 'Chubut',
    aliases: ['CHUBUT', 'EL CHUBUT'],
  },
  {
    name: 'Córdoba',
    aliases: ['CORDOBA', 'CBA', 'CORDOBA CAPITAL', 'CORDO1BWA2', 'CORDOBA ARG'],
  },
  {
    name: 'Corrientes',
    aliases: ['CORRIENTES'],
  },
  {
    name: 'Entre Ríos',
    aliases: ['ENTRE RIOS', 'E. RIOS', 'E.RIOS', 'ENTRERIOS'],
  },
  {
    name: 'Formosa',
    aliases: ['FORMOSA'],
  },
  {
    name: 'Jujuy',
    aliases: ['JUJUY', 'SAN SALVADOR DE JUJUY'],
  },
  {
    name: 'La Pampa',
    aliases: ['LA PAMPA', 'LAPAMPA', 'LA PAMPA PROVINCE', 'PAMPA'],
  },
  {
    name: 'La Rioja',
    aliases: ['LA RIOJA', 'LA RIOJA CAPITAL', 'LARIOJA'],
  },
  {
    name: 'Mendoza',
    aliases: ['MENDOZA', 'MZA'],
  },
  {
    name: 'Misiones',
    aliases: ['MISIONES', 'MUSIONES', 'POSADAS'],
  },
  {
    name: 'Neuquén',
    aliases: ['NEUQUEN', 'NEUQUEN CAPITAL', 'NQN', 'NEUKEN'],
  },
  {
    name: 'Río Negro',
    aliases: ['RIO NEGRO', 'RIONEGRO', 'RIO NEGRO ATRIEL', 'R NEGRO', 'R.NEGRO'],
  },
  {
    name: 'Salta',
    aliases: ['SALTA', 'SALTA CAPITAL'],
  },
  {
    name: 'San Juan',
    aliases: ['SAN JUAN', 'SANJUAN', 'S. JUAN', 'S.JUAN'],
  },
  {
    name: 'San Luis',
    aliases: ['SAN LUIS', 'SANLUIS', 'SA LUIS', 'S. LUIS', 'S.LUIS'],
  },
  {
    name: 'Santa Cruz',
    aliases: ['SANTA CRUZ', 'STA CRUZ', 'STA. CRUZ'],
  },
  {
    name: 'Santa Fe',
    aliases: ['SANTA FE', 'SANTAFE', 'STA FE', 'STA. FE', 'LA CAPITAL - SANTA FE', 'ROSARIO'],
  },
  {
    name: 'Santiago del Estero',
    aliases: [
      'SANTIAGO DEL ESTERO', 'SGO DEL ESTERO', 'STGO DEL ESTERO',
      'SANTIAGO ESTERO', 'STGO. DEL ESTERO',
    ],
  },
  {
    name: 'Tierra del Fuego',
    aliases: [
      'TIERRA DEL FUEGO', 'TIERRA DEL FUEGA', 'USHUAIA',
      'TIERRA DEL FUEGO ANTARTIDA E ISLAS DEL ATLANTICO SUR',
      'PROVINCIA DE TIERRA DEL FUEGO ANTARTIDA E ISLAS DEL ATLANTICO SUR',
    ],
  },
  {
    name: 'Tucumán',
    aliases: ['TUCUMAN', 'SAN MIGUEL DE TUCUMAN', 'TUCUMAN CAPITAL'],
  },
];

const CANONICAL_NAMES = CANONICAL_PROVINCES.map(p => p.name);

// Map normalizedAlias → canonicalName, para búsquedas O(1).
const ALIAS_INDEX = (() => {
  const map = new Map();
  for (const prov of CANONICAL_PROVINCES) {
    for (const alias of prov.aliases) {
      map.set(alias, prov.name);
    }
  }
  return map;
})();

/**
 * Normaliza un input crudo de provincia: upper, sin acentos, espacios colapsados,
 * trim. Devuelve string vacío si el input es null/undefined/vacío.
 */
function normalizeProvinceRaw(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Si el input normalizado coincide con uno de los alias canónicos, devuelve el
 * nombre canónico. Si no, devuelve null y hay que ir a cache / Claude.
 */
function findCanonicalByAlias(normalized) {
  if (!normalized) return null;
  return ALIAS_INDEX.get(normalized) || null;
}

module.exports = {
  CANONICAL_PROVINCES,
  CANONICAL_NAMES,
  normalizeProvinceRaw,
  findCanonicalByAlias,
};
