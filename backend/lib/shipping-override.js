/**
 * Shipping Override Helper
 *
 * Centraliza la lógica de cambiar shipping_type / shipping_request "manualmente"
 * (sin pasar por el sync con TN). Usado por:
 *   - PATCH /orders/:orderNumber/shipping (admin desde detalle)
 *   - [Futuro PR 2] POST /shipping-change (cliente via link público)
 *
 * Setea shipping_overridden_at para que los webhooks de TN y el divergence-detector
 * no pisen shipping_type ni shipping_address con los valores de TN.
 *
 * Cambios atómicos en transacción:
 *   1. UPDATE orders_validated.shipping_type + flag + (opcional) limpieza de
 *      envio_nube_label_printed_at / qlick_*
 *   2. DELETE o UPSERT en shipping_requests según el método nuevo
 *   3. DELETE de scheduled_whatsapp 'pendiente_datos_envio%' pendientes
 *
 * Después del commit llama a recalcularPagos para que estado_pedido pre-impresión
 * (pendiente_pago / pendiente_datos_envio / a_imprimir) quede consistente.
 *
 * Validaciones:
 *   - Estado actual debe ser <= por_empaquetar (3.8) y != cancelado.
 *   - Si nuevo método es Envío y no se mandó shippingRequestData → error.
 *   - Si carrier "Otro" cae en FORBIDDEN_CARRIERS (Andreani/OCA/Correo) → error.
 */

const pool = require('../db');
const { apiLogger: log } = require('./logger');
const { logEvento } = require('../utils/logging');
const { esRetiro, ESTADO_PEDIDO_ORDER, isEnvioNubeShipping } = require('./estados-pedido');
const { isForbiddenCarrier } = require('./payment-helpers');
const { isQlickShipping } = require('./qlick');
const { recalcularPagos } = require('./recalcularPagos');

// Estado tope para permitir el cambio. Hasta por_empaquetar (3.8) inclusive.
// Desde empaquetado (4.0) en adelante el pedido ya está físicamente armado y
// no tiene sentido cambiar el método. Cancelado también bloquea.
const MAX_ORDER_FOR_CHANGE = ESTADO_PEDIDO_ORDER.por_empaquetar; // 3.8

function canChangeShipping(estadoPedido) {
  if (estadoPedido === 'cancelado') return false;
  const order = ESTADO_PEDIDO_ORDER[estadoPedido];
  if (order === undefined) return false;
  return order <= MAX_ORDER_FOR_CHANGE;
}

/**
 * Aplica el override de método de envío al pedido.
 *
 * @param {string} orderNumber
 * @param {object} opts
 * @param {string} opts.newShippingType - Valor final a guardar en orders_validated.shipping_type
 *   (ej. "Retiro", "Via Cargo", "Expreso a elección"). El caller decide el mapeo.
 * @param {object|null} opts.shippingRequestData - Datos del form si nuevo método es Envío. null si Retiro.
 *   Estructura esperada: { empresa_envio, empresa_envio_otro, destino_tipo, direccion_entrega,
 *   nombre_apellido, dni, email, codigo_postal, provincia, localidad, telefono, comentarios }
 * @param {'admin'|'cliente'} opts.triggeredBy
 * @param {string} [opts.username] - solo si triggeredBy='admin'
 * @returns {Promise<{
 *   applied: boolean,
 *   oldShippingType: string|null,
 *   newShippingType: string|null,
 *   reason: 'ok'|'order_not_found'|'state_not_allowed'|'missing_shipping_data'|'forbidden_carrier'|'same_method',
 * }>}
 */
async function applyShippingOverride(orderNumber, opts = {}) {
  const {
    newShippingType,
    shippingRequestData = null,
    triggeredBy = 'admin',
    username = null,
  } = opts;

  if (!newShippingType || typeof newShippingType !== 'string') {
    return { applied: false, oldShippingType: null, newShippingType: null, reason: 'missing_shipping_data' };
  }

  const newIsPickup = esRetiro({ shipping_type: newShippingType });

  // Si nuevo método es Envío, exigir datos. Si es Retiro, datos no aplican.
  if (!newIsPickup) {
    if (!shippingRequestData || typeof shippingRequestData !== 'object') {
      return { applied: false, oldShippingType: null, newShippingType: null, reason: 'missing_shipping_data' };
    }
    // Validar carrier prohibido cuando es "OTRO".
    if (shippingRequestData.empresa_envio === 'OTRO' &&
        shippingRequestData.empresa_envio_otro &&
        isForbiddenCarrier(shippingRequestData.empresa_envio_otro)) {
      return { applied: false, oldShippingType: null, newShippingType: null, reason: 'forbidden_carrier' };
    }
  }

  // 1. Cargar estado actual del pedido.
  const stateRes = await pool.query(
    `SELECT estado_pedido, shipping_type FROM orders_validated WHERE order_number = $1`,
    [orderNumber]
  );
  const orderRow = stateRes.rows[0];
  if (!orderRow) {
    return { applied: false, oldShippingType: null, newShippingType: null, reason: 'order_not_found' };
  }

  // 2. Validar estado permitido.
  if (!canChangeShipping(orderRow.estado_pedido)) {
    return {
      applied: false,
      oldShippingType: orderRow.shipping_type,
      newShippingType: null,
      reason: 'state_not_allowed',
    };
  }

  const oldType = orderRow.shipping_type || '';
  const oldIsPickup = esRetiro({ shipping_type: oldType });
  const oldIsEnvioNube = isEnvioNubeShipping(oldType);
  const oldIsQlick = isQlickShipping(oldType);

  // Detectar "no-op" cuando el método y los datos no cambian. Comparación liviana:
  // mismo shipping_type Y (mismo modo Retiro/Envío). Si es Envío con datos nuevos
  // siempre dejamos pasar (los datos pueden haber cambiado aunque la empresa no).
  if (oldType === newShippingType && oldIsPickup === newIsPickup && newIsPickup) {
    return {
      applied: false,
      oldShippingType: oldType,
      newShippingType,
      reason: 'same_method',
    };
  }

  // 3. Transacción: UPDATE pedido + manejar shipping_requests + cancelar WAs.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 3a. UPDATE shipping_type + flag + limpieza de flags huérfanos.
    // Si el método anterior era Envío Nube o Qlick (que ya no van a aplicar),
    // limpiamos los timestamps de etiqueta para que la card vieja no se muestre.
    const clearEnvioNube = oldIsEnvioNube ? ', envio_nube_label_printed_at = NULL' : '';
    const clearQlick = oldIsQlick
      ? `, qlick_guia_number = NULL, qlick_remito = NULL, qlick_servicio_codigo = NULL,
         qlick_importe = NULL, qlick_zona = NULL, qlick_generated_at = NULL,
         qlick_label_printed_at = NULL`
      : '';

    await client.query(
      `UPDATE orders_validated
         SET shipping_type = $1,
             shipping_overridden_at = NOW(),
             updated_at = NOW()
             ${clearEnvioNube}
             ${clearQlick}
       WHERE order_number = $2`,
      [newShippingType, orderNumber]
    );

    // 3b. Manejar shipping_requests según nuevo método.
    if (newIsPickup) {
      // Retiro: borrar shipping_request si existía.
      await client.query(
        `DELETE FROM shipping_requests WHERE order_number = $1`,
        [orderNumber]
      );
    } else {
      // Envío: UPSERT con los datos nuevos.
      // Si ya existía un row con empresa_envio distinto, reseteamos
      // label_printed_at, label_bultos y reprints_count (la etiqueta vieja
      // ya no sirve porque cambió el carrier).
      const d = shippingRequestData;
      await client.query(`
        INSERT INTO shipping_requests (
          order_number, empresa_envio, empresa_envio_otro, destino_tipo,
          direccion_entrega, nombre_apellido, dni, email,
          codigo_postal, provincia, localidad, telefono, comentarios
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (order_number) DO UPDATE SET
          empresa_envio = EXCLUDED.empresa_envio,
          empresa_envio_otro = EXCLUDED.empresa_envio_otro,
          destino_tipo = EXCLUDED.destino_tipo,
          direccion_entrega = EXCLUDED.direccion_entrega,
          nombre_apellido = EXCLUDED.nombre_apellido,
          dni = EXCLUDED.dni,
          email = EXCLUDED.email,
          codigo_postal = EXCLUDED.codigo_postal,
          provincia = EXCLUDED.provincia,
          localidad = EXCLUDED.localidad,
          telefono = EXCLUDED.telefono,
          comentarios = EXCLUDED.comentarios,
          data_updated_at = NOW(),
          label_printed_at = CASE
            WHEN shipping_requests.empresa_envio IS DISTINCT FROM EXCLUDED.empresa_envio THEN NULL
            ELSE shipping_requests.label_printed_at
          END,
          label_bultos = CASE
            WHEN shipping_requests.empresa_envio IS DISTINCT FROM EXCLUDED.empresa_envio THEN NULL
            ELSE shipping_requests.label_bultos
          END,
          reprints_count = CASE
            WHEN shipping_requests.empresa_envio IS DISTINCT FROM EXCLUDED.empresa_envio THEN 0
            ELSE shipping_requests.reprints_count
          END
      `, [
        orderNumber,
        d.empresa_envio,
        d.empresa_envio === 'OTRO' ? (d.empresa_envio_otro || null) : null,
        d.destino_tipo,
        d.direccion_entrega,
        d.nombre_apellido,
        d.dni,
        d.email,
        d.codigo_postal,
        d.provincia,
        d.localidad,
        d.telefono,
        d.comentarios || null,
      ]);
    }

    // 3c. Cancelar scheduled_whatsapp pendientes de pendiente_datos_envio.
    // Si el nuevo método es Retiro NO hace falta el form. Si es Envío con
    // datos ya cargados (lo que acabamos de hacer arriba) tampoco. En ambos
    // casos los WAs viejos quedaron sin sentido.
    await client.query(
      `DELETE FROM scheduled_whatsapp
        WHERE order_number = $1
          AND plantilla LIKE 'pendiente_datos_envio%'
          AND sent_at IS NULL`,
      [orderNumber]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // 4. Recalcular pagos (después del commit, usa el pool global).
  // Esto puede mover el pedido entre {pendiente_pago, pendiente_datos_envio,
  // a_imprimir} según los nuevos requisitos del método. No retrocede estados
  // de depo (eso es por diseño — ver memoria pendiente_cambiar_envio).
  try {
    await recalcularPagos(pool, orderNumber);
  } catch (e) {
    log.warn({ orderNumber, err: e.message }, 'recalcularPagos falló tras shipping override');
  }

  // 5. Log evento.
  const accion = `Método de envío modificado: ${oldType || '(vacío)'} → ${newShippingType}`;
  await logEvento({
    orderNumber,
    accion,
    origen: triggeredBy === 'admin' ? 'admin' : 'cliente',
    username,
  }).catch(() => {});

  log.info({ orderNumber, from: oldType, to: newShippingType, triggeredBy }, 'shipping_type overrideado');

  return {
    applied: true,
    oldShippingType: oldType,
    newShippingType,
    reason: 'ok',
  };
}

module.exports = {
  applyShippingOverride,
  canChangeShipping,
};
