// Cliente para la API V2 de Qlick (https://qlicksrl.epresis.com).
// Genera guías y descarga etiquetas HTML para impresión térmica.

const axios = require('axios');

const QLICK_BASE = process.env.QLICK_API_BASE || 'https://qlicksrl.epresis.com';
const QLICK_TIMEOUT_MS = 20000;

// Constantes operativas — cambiar acá si Blanquería cambia sucursal o tipo de bulto
const SUCURSAL = process.env.QLICK_SUCURSAL || 'BLANQUERIA1';
const CP_ORIGEN = process.env.QLICK_CP_ORIGEN || '1437';
const PESO_POR_BULTO = parseFloat(process.env.QLICK_PESO_POR_BULTO || '10'); // kg
const DIMENSIONES_BULTO = {
  alto: 0.15,
  largo: 0.40,
  profundidad: 0.30,
};

// Servicios disponibles (de /api/v2/serviciosByCliente.json)
const SERVICIO_AMBA = '101';      // PRIORITARIO (CABA/GBA)
const SERVICIO_INTERIOR = '103';  // INTERIOR I
const SERVICIO_INTERIOR_FALLBACK = '104'; // INTERIOR 2

function getToken() {
  const token = process.env.QLICK_API_TOKEN;
  if (!token) throw new Error('Falta QLICK_API_TOKEN en entorno');
  return token;
}

function isQlickShipping(shippingType) {
  if (!shippingType) return false;
  return /qlick/i.test(String(shippingType));
}

function servicioPorCP(cp) {
  const n = parseInt(String(cp).replace(/\D/g, '').slice(0, 4), 10);
  if (!Number.isFinite(n) || n === 0) return SERVICIO_INTERIOR;
  if (n < 1900) return SERVICIO_AMBA;
  return SERVICIO_INTERIOR;
}

function parseAltura(numberStr) {
  if (numberStr == null) return { altura: 0, resto: '' };
  const s = String(numberStr).trim();
  const m = s.match(/^(\d{1,6})(.*)$/);
  if (!m) return { altura: 0, resto: s };
  return { altura: parseInt(m[1], 10), resto: m[2].trim() };
}

function parseCP(zipcode) {
  if (!zipcode) return 0;
  const digits = String(zipcode).match(/\d+/g);
  if (!digits) return 0;
  const onlyDigits = digits.join('');
  // CPA formato "C1043AAZ" -> tomar dígitos centrales (4 dígitos)
  if (onlyDigits.length >= 4) return parseInt(onlyDigits.slice(0, 4), 10);
  return parseInt(onlyDigits, 10) || 0;
}

function buildComprador(order, shippingAddress, shippingRequest) {
  const sa = shippingAddress || {};
  const sr = shippingRequest || {};
  const { altura, resto } = parseAltura(sa.number);
  const cp = parseCP(sa.zipcode);

  const floor = (sa.floor || '').trim();
  // Si floor parece piso/dpto cortito (≤10 chars y sin espacios o solo formato "PB 4" / "3 B"), usar como piso.
  // Si no, mandarlo como info_adicional_1 para no romper Qlick.
  let piso = null;
  let info1 = null;
  if (floor) {
    if (floor.length <= 10 && /^[\w°\s\-./]+$/.test(floor)) piso = floor;
    else info1 = floor;
  }

  return {
    destinatario: sa.name || order.customer_name || '',
    calle: (sa.address || '').trim(),
    altura: altura || 0,
    piso: piso,
    dpto: null,
    localidad: sa.city || sa.locality || '',
    provincia: sa.province || '',
    cp: cp,
    email: order.customer_email || '',
    celular: (sa.phone || order.customer_phone || '').replace(/\s+/g, ''),
    cuit: sr.dni || null,
    contenido: buildContenido(order),
    info_adicional_1: info1 || (resto || null),
    info_adicional_2: sa.locality && sa.locality !== sa.city ? sa.locality : null,
  };
}

function buildContenido(order) {
  const items = order.items || [];
  if (!items.length) return 'Productos blanquería';
  const partes = items.slice(0, 5).map((it) => {
    const qty = it.quantity ? `${it.quantity}x ` : '';
    return `${qty}${(it.name || '').slice(0, 40)}`;
  });
  let txt = partes.join(', ');
  if (items.length > 5) txt += `, +${items.length - 5} ítems`;
  return txt.slice(0, 250);
}

function buildProductos(bultos) {
  const b = Math.max(1, parseInt(bultos, 10) || 1);
  return [{
    bultos: b,
    peso: PESO_POR_BULTO * b,
    descripcion: 'Productos textiles',
    dimensiones: { ...DIMENSIONES_BULTO },
  }];
}

/**
 * Genera una guía en Qlick.
 * @param {object} input
 * @param {object} input.order               { order_number, customer_name, customer_email, customer_phone, items }
 * @param {object} input.shippingAddress     jsonb desde TN
 * @param {object} input.shippingRequest     row de shipping_requests (puede ser null)
 * @param {number} input.bultos              cantidad de bultos a despachar
 * @param {string} [input.codigoServicio]    override del servicio. Si no se pasa, se calcula por CP.
 * @returns {Promise<{ok:boolean, guia?:number, importe?:number, remito?:string, zona?:string, codigo_servicio?:string, raw:object, error?:string}>}
 */
async function generarGuia({ order, shippingAddress, shippingRequest, bultos, codigoServicio }) {
  const token = getToken();
  const comprador = buildComprador(order, shippingAddress, shippingRequest);
  const productos = buildProductos(bultos);
  const servicio = codigoServicio || servicioPorCP(comprador.cp);
  const tipoOperacion = (shippingRequest?.destino_tipo || '').toUpperCase() === 'SUCURSAL' ? 'RETIRO' : 'ENTREGA';

  const body = {
    api_token: token,
    codigo_sucursal: SUCURSAL,
    codigo_servicio: servicio,
    internacional: false,
    isInversa: false,
    is_urgente: false,
    pago_en: 'ORIGEN',
    tipo_operacion: tipoOperacion,
    observaciones: `Pedido #${order.order_number}`,
    remito: String(order.order_number || '').slice(0, 30),
    comprador,
    productos,
  };

  try {
    const r = await axios.post(`${QLICK_BASE}/api/v2/guias.json`, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: QLICK_TIMEOUT_MS,
    });
    const data = r.data || {};
    if (!data.guia) {
      return { ok: false, error: data.message || 'Respuesta sin número de guía', raw: data };
    }
    return {
      ok: true,
      guia: data.guia,
      importe: data.importe ?? null,
      remito: data.remito ?? null,
      zona: data.zona ?? null,
      sub_zona: data.sub_zona_destino ?? null,
      codigo_servicio: servicio,
      raw: data,
    };
  } catch (e) {
    const respData = e.response?.data;
    let msg = respData?.message || respData?.error_message || e.message;
    if (servicio === SERVICIO_INTERIOR && /no hay precio cargado/i.test(String(msg))) {
      // Reintento con fallback de servicio interior
      return generarGuia({ order, shippingAddress, shippingRequest, bultos, codigoServicio: SERVICIO_INTERIOR_FALLBACK });
    }
    return { ok: false, error: msg, status: e.response?.status, raw: respData };
  }
}

/**
 * Descarga la etiqueta HTML para una o varias guías ya generadas.
 * Devuelve el HTML crudo que renderiza Qlick (formato 150x100 mm térmica).
 * @param {number|number[]|string|string[]} guias
 * @returns {Promise<string>}
 */
async function descargarEtiquetaHTML(guias) {
  const token = getToken();
  const ids = (Array.isArray(guias) ? guias : [guias]).map((g) => String(g)).join(',');
  const r = await axios.post(
    `${QLICK_BASE}/api/v1/public/print_etiquetas.json`,
    { api_token: token, ids },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000, responseType: 'text' }
  );
  if (typeof r.data === 'string') return r.data;
  // Si Qlick respondió JSON con error, propagar
  if (r.data && r.data.message) throw new Error(r.data.message);
  return String(r.data);
}

module.exports = {
  generarGuia,
  descargarEtiquetaHTML,
  isQlickShipping,
  servicioPorCP,
  parseAltura,
  parseCP,
  buildComprador,
  buildProductos,
  SUCURSAL,
  CP_ORIGEN,
  PESO_POR_BULTO,
  SERVICIO_AMBA,
  SERVICIO_INTERIOR,
  SERVICIO_INTERIOR_FALLBACK,
};
