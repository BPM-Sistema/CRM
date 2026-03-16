// Configuración visual de eventos del historial

export interface EventConfig {
  emoji: string;
  label: string;
  color: string; // Tailwind classes para el fondo del emoji
}

const EVENT_CONFIG: Record<string, EventConfig> = {
  // Comprobantes
  'upload': {
    emoji: '📤',
    label: 'Comprobante subido',
    color: 'bg-slate-100'
  },
  'comprobante_confirmado': {
    emoji: '✅',
    label: 'Comprobante confirmado',
    color: 'bg-green-100'
  },
  'comprobante_rechazado': {
    emoji: '❌',
    label: 'Comprobante rechazado',
    color: 'bg-red-100'
  },
  'comprobante_duplicado': {
    emoji: '⚠️',
    label: 'Comprobante duplicado',
    color: 'bg-amber-100'
  },

  // Estados de pedido
  'hoja_impresa': {
    emoji: '🖨️',
    label: 'Hoja impresa',
    color: 'bg-blue-100'
  },
  'pedido_armado': {
    emoji: '📦',
    label: 'Pedido armado',
    color: 'bg-purple-100'
  },
  'pedido_retirado': {
    emoji: '🚶',
    label: 'Pedido retirado',
    color: 'bg-teal-100'
  },
  'pedido_en_calle': {
    emoji: '🛵',
    label: 'Pedido en calle',
    color: 'bg-cyan-100'
  },
  'pedido_enviado': {
    emoji: '✈️',
    label: 'Pedido enviado',
    color: 'bg-indigo-100'
  },
  'pedido_cancelado': {
    emoji: '🚫',
    label: 'Pedido cancelado',
    color: 'bg-red-100'
  },

  // Pagos
  'pago_efectivo_registrado': {
    emoji: '💵',
    label: 'Pago en efectivo',
    color: 'bg-amber-100'
  },
  'pago_sincronizado_cola': {
    emoji: '🔄',
    label: 'Pago sincronizado',
    color: 'bg-slate-100'
  },

  // Comunicación
  'whatsapp_cliente_enviado': {
    emoji: '💬',
    label: 'WhatsApp enviado',
    color: 'bg-green-100'
  },

  // Remitos
  'remito_subido': {
    emoji: '📄',
    label: 'Remito subido',
    color: 'bg-slate-100'
  },
  'remito_confirmado': {
    emoji: '✅',
    label: 'Remito confirmado',
    color: 'bg-green-100'
  },

  // Etiquetas
  'etiqueta_impresa': {
    emoji: '🏷️',
    label: 'Etiqueta impresa',
    color: 'bg-violet-100'
  },
  'envio_nube_label_descargada': {
    emoji: '🏷️',
    label: 'Etiqueta Envío Nube',
    color: 'bg-indigo-100'
  },
  'envio_nube_label_masiva': {
    emoji: '🏷️',
    label: 'Etiquetas masivas',
    color: 'bg-indigo-100'
  },
};

// Patrones para eventos dinámicos (webhooks de TiendaNube y otros)
const DYNAMIC_PATTERNS: Array<{ pattern: RegExp; config: EventConfig }> = [
  {
    pattern: /añadido/i,
    config: { emoji: '➕', label: 'Producto añadido', color: 'bg-green-100' }
  },
  {
    pattern: /eliminado/i,
    config: { emoji: '➖', label: 'Producto eliminado', color: 'bg-red-100' }
  },
  {
    pattern: /disminuido/i,
    config: { emoji: '📉', label: 'Cantidad reducida', color: 'bg-orange-100' }
  },
  {
    pattern: /Nuevo monto/i,
    config: { emoji: '💰', label: 'Monto actualizado', color: 'bg-amber-100' }
  },
  {
    pattern: /etiqueta_impresa_\d+_bultos/i,
    config: { emoji: '🏷️', label: 'Etiqueta impresa', color: 'bg-violet-100' }
  },
];

// Default para eventos no reconocidos
const DEFAULT_CONFIG: EventConfig = {
  emoji: '📋',
  label: 'Evento',
  color: 'bg-neutral-100'
};

/**
 * Obtiene la configuración visual para un evento
 * Busca match exacto primero, luego por prefijo, luego patrones dinámicos
 */
export function getEventConfig(accion: string): EventConfig {
  // 1. Match exacto
  if (EVENT_CONFIG[accion]) {
    return EVENT_CONFIG[accion];
  }

  // 2. Match por prefijo (para "comprobante_rechazado: motivo")
  for (const [key, config] of Object.entries(EVENT_CONFIG)) {
    if (accion.startsWith(key)) {
      return config;
    }
  }

  // 3. Patrones dinámicos (webhooks)
  for (const { pattern, config } of DYNAMIC_PATTERNS) {
    if (pattern.test(accion)) {
      return config;
    }
  }

  // 4. Default
  return DEFAULT_CONFIG;
}

/**
 * Formatea el texto de la acción para mostrar
 * Mantiene el texto original pero puede limpiar prefijos si es necesario
 */
export function formatEventLabel(accion: string): string {
  // Para rechazos con motivo, mostrar el motivo más limpio
  if (accion.startsWith('comprobante_rechazado:')) {
    const motivo = accion.replace('comprobante_rechazado:', '').trim();
    return motivo ? `Rechazado: ${motivo}` : 'Comprobante rechazado';
  }

  // Para cambios de pedido (webhook), mostrar el texto completo
  if (accion.includes('—') || accion.includes('Nuevo monto')) {
    return accion;
  }

  // Para el resto, usar el label configurado o el texto original
  const config = getEventConfig(accion);
  return config.label !== 'Evento' ? config.label : accion;
}
