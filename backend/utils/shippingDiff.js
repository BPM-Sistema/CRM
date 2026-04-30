// Helper para construir el texto del diff de shipping_requests que se logea en
// la tabla `logs.accion`. Lo lee la timeline del detalle del pedido.
//
// Patrón usado: el `accion` lleva un em-dash (—) para que el frontend
// (formatEventLabel en eventConfig.ts) lo muestre completo en lugar de
// reemplazarlo por la label del evento.

const FIELD_LABELS = {
  empresa_envio: 'Transporte',
  empresa_envio_otro: 'Transporte (otro)',
  destino_tipo: 'Tipo',
  direccion_entrega: 'Dirección',
  nombre_apellido: 'Nombre',
  dni: 'DNI',
  codigo_postal: 'CP',
  provincia: 'Provincia',
  localidad: 'Localidad',
  telefono: 'Teléfono',
  email: 'Email',
  comentarios: 'Comentarios',
};

const VALUE_LABELS = {
  empresa_envio: { VIA_CARGO: 'Vía Cargo', OTRO: 'Otro' },
  destino_tipo: { SUCURSAL: 'Sucursal', DOMICILIO: 'Domicilio' },
};

// Orden de prioridad para mostrar (los críticos primero).
const FIELD_ORDER = [
  'empresa_envio',
  'empresa_envio_otro',
  'destino_tipo',
  'direccion_entrega',
  'localidad',
  'provincia',
  'codigo_postal',
  'nombre_apellido',
  'dni',
  'telefono',
  'email',
  'comentarios',
];

const MAX_FIELDS_IN_LOG = 5;

function humanValue(field, value) {
  if (value === null || value === undefined || value === '') return '∅';
  const dict = VALUE_LABELS[field];
  if (dict && dict[value]) return dict[value];
  return String(value);
}

// Snapshot inicial: lista los campos clave del row recién creado.
function buildInitialSnapshot(row) {
  if (!row) return '';
  const parts = [];
  // Para el snapshot inicial mostramos solo los campos visibles en la etiqueta.
  const initialFields = ['empresa_envio', 'destino_tipo', 'direccion_entrega', 'localidad', 'provincia'];
  for (const field of initialFields) {
    const val = row[field];
    if (val !== null && val !== undefined && val !== '') {
      parts.push(`${FIELD_LABELS[field]}: ${humanValue(field, val)}`);
    }
  }
  // Si empresa_envio es OTRO, mostrar también el nombre del transporte.
  if (row.empresa_envio === 'OTRO' && row.empresa_envio_otro) {
    const idx = parts.findIndex(p => p.startsWith('Transporte:'));
    if (idx >= 0) parts[idx] = `Transporte: Otro (${row.empresa_envio_otro})`;
  }
  return parts.join(', ');
}

// Combina empresa_envio + empresa_envio_otro en una sola descripción humana.
// Ej: VIA_CARGO → "Vía Cargo"; OTRO + "Cargo Sur" → "Otro (Cargo Sur)".
function transportLabel(empresa, otro) {
  if (empresa === 'OTRO' && otro) return `Otro (${otro})`;
  return humanValue('empresa_envio', empresa);
}

// Diff entre prev y next: lista solo los campos que cambiaron.
// Devuelve { text, changedFields: string[] }.
function buildDiff(prev, next) {
  if (!prev || !next) return { text: '', changedFields: [] };

  const changed = [];
  for (const field of FIELD_ORDER) {
    const a = prev[field] ?? null;
    const b = next[field] ?? null;
    if (a !== b) changed.push(field);
  }

  if (changed.length === 0) return { text: '', changedFields: [] };

  // Si cambió empresa_envio o empresa_envio_otro, consolidamos en un solo
  // item "Transporte" para mostrar el nombre completo del transporte.
  const transportChanged = changed.includes('empresa_envio') || changed.includes('empresa_envio_otro');
  const otherChanged = changed.filter(f => f !== 'empresa_envio' && f !== 'empresa_envio_otro');

  const items = [];
  if (transportChanged) {
    const before = transportLabel(prev.empresa_envio, prev.empresa_envio_otro);
    const after = transportLabel(next.empresa_envio, next.empresa_envio_otro);
    items.push({ field: 'empresa_envio', text: `Transporte: ${before} → ${after}` });
  }
  for (const field of otherChanged) {
    const label = FIELD_LABELS[field] || field;
    const before = humanValue(field, prev[field]);
    const after = humanValue(field, next[field]);
    items.push({ field, text: `${label}: ${before} → ${after}` });
  }

  const fieldsToShow = items.slice(0, MAX_FIELDS_IN_LOG);
  const overflow = items.length - fieldsToShow.length;

  let text = fieldsToShow.map(i => i.text).join(', ');
  if (overflow > 0) text += ` (+${overflow} ${overflow === 1 ? 'campo' : 'campos'})`;

  return { text, changedFields: changed };
}

module.exports = {
  buildInitialSnapshot,
  buildDiff,
};
