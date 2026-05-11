/**
 * Whitelist de transiciones permitidas desde el QR del depo (Fase 2 PR 4).
 *
 * El QR es ESTRICTO (a diferencia del flujo de oficina que es flexible).
 * Solo permite las transiciones definidas en este archivo. Cualquier otra
 * combinación (from, to) se rechaza.
 *
 * Diseño de los botones por estado, decidido en planeación 2026-05-08:
 *   hoja_impresa     → en_preparacion
 *   en_preparacion   → en_revision (principal) + pendiente_stock (secundario)
 *   pendiente_stock  → en_revision (único; salta volver a en_preparacion)
 *   en_revision     → por_empaquetar (principal) + pendiente_stock (secundario)
 *   por_empaquetar  → empaquetado (requiere bultos)
 *   empaquetado     → empaquetado (reconfigurar bultos sin cambiar estado)
 *
 * `requiresBultos`: bultos es obligatorio en el body de la transición.
 *
 * `selfTransition`: la transición no cambia estado_pedido — usada para
 *   reconfigurar bultos cuando ya está en empaquetado.
 */

const TRANSITIONS = [
  // hoja_impresa → preparacion
  { from: 'hoja_impresa',    to: 'en_preparacion'   },

  // en_preparacion → revision o pend stock
  { from: 'en_preparacion',  to: 'en_revision'      },
  { from: 'en_preparacion',  to: 'pendiente_stock'  },

  // pendiente_stock → revision (única salida; salta volver a preparacion)
  { from: 'pendiente_stock', to: 'en_revision'      },

  // en_revision → por_empaquetar o pend stock
  { from: 'en_revision',     to: 'por_empaquetar'   },
  { from: 'en_revision',     to: 'pendiente_stock'  },

  // por_empaquetar → empaquetado (con bultos)
  { from: 'por_empaquetar',  to: 'empaquetado', requiresBultos: true },

  // empaquetado → empaquetado (reconfigurar bultos sin cambiar estado)
  { from: 'empaquetado',     to: 'empaquetado', requiresBultos: true, selfTransition: true },
];

/**
 * Devuelve la definición de transición si está permitida; null si no.
 */
function findTransition(fromEstado, toEstado) {
  return TRANSITIONS.find(t => t.from === fromEstado && t.to === toEstado) || null;
}

/**
 * Lista las transiciones permitidas desde un estado dado.
 * Útil para que el frontend sepa qué botones mostrar.
 */
function allowedFrom(fromEstado) {
  return TRANSITIONS.filter(t => t.from === fromEstado);
}

/**
 * Lista la `transicion` (key) que un empleado debe tener para disparar
 * la transición. Convención: usar el to_status como key del permiso.
 * Esto matchea el `transicion` de warehouse_user_permissions.
 */
function permissionKey(toEstado) {
  return toEstado;
}

module.exports = {
  TRANSITIONS,
  findTransition,
  allowedFrom,
  permissionKey,
};
