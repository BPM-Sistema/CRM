/**
 * Worker que procesa la cola pending_sheet_pushes y aplica los pushes al
 * Google Sheet de a_imprimir.
 *
 * No usa BullMQ — es un poller simple que lee de DB cada 5s. La cola está
 * en tabla pending_sheet_pushes (migration 102). Reemplazó al setImmediate
 * del flujo original, que se rompía en Cloud Run con cpu-throttling cuando
 * se encolaban muchos pushes via batch (conciliación bancaria).
 *
 * Procesamiento secuencial (uno a la vez, sin paralelo): el sheet API tiene
 * rate limit de 60 reads + 60 writes/min, y un push = 1 read + 1 write.
 * Procesando uno por uno con 5s entre ticks queda muy lejos del límite.
 *
 * Retry: si el push falla, attempts se incrementa al "claim". Hasta MAX_ATTEMPTS
 * (5). Después el row queda con last_error y processed_at NULL (no se procesa
 * más). Para retomar, bajar manualmente attempts y limpiar last_error.
 */

const pool = require('../db');
const { pushOrderToImprimir } = require('../lib/sheets-helpers');
const { workerLogger: log } = require('../lib/logger');

const TICK_MS = 5000;
const MAX_ATTEMPTS = 5;

/**
 * Claim atomic del próximo row pendiente. Incrementa attempts (lock-then-claim)
 * y devuelve los datos. Si no hay nada para procesar, devuelve null.
 */
async function claimNext() {
  const r = await pool.query(`
    UPDATE pending_sheet_pushes
       SET attempts = attempts + 1
     WHERE id = (
       SELECT id FROM pending_sheet_pushes
        WHERE processed_at IS NULL
          AND attempts < $1
        ORDER BY enqueued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, order_number, attempts
  `, [MAX_ATTEMPTS]);
  return r.rows[0] || null;
}

async function markProcessed(id) {
  await pool.query(
    `UPDATE pending_sheet_pushes SET processed_at = NOW(), last_error = NULL WHERE id = $1`,
    [id]
  );
}

async function markError(id, errorMsg) {
  await pool.query(
    `UPDATE pending_sheet_pushes SET last_error = $1 WHERE id = $2`,
    [errorMsg, id]
  );
}

async function processOne() {
  let row;
  try {
    row = await claimNext();
  } catch (err) {
    log.error({ err: err.message }, 'sheet-pusher: claim error');
    return false;
  }
  if (!row) return false;

  const { id, order_number, attempts } = row;
  try {
    const result = await pushOrderToImprimir(order_number);
    if (result.appended || result.reason === 'already_in_sheet') {
      await markProcessed(id);
      log.info({ orderNumber: order_number, attempts, reason: result.reason || 'appended' }, 'sheet-pusher: ok');
    } else {
      // Reasons: 'no_order' | 'no_spreadsheet_id' | 'no_credentials' | 'api_error'
      // Si es de config (no credentials), no tiene sentido reintentar — pero
      // dejamos que el contador llegue a MAX_ATTEMPTS y se detenga solo.
      await markError(id, `push fallido: ${result.reason || 'unknown'}`);
      log.warn({ orderNumber: order_number, attempts, reason: result.reason }, 'sheet-pusher: push fallido');
    }
  } catch (err) {
    await markError(id, err.message || String(err));
    log.error({ orderNumber: order_number, attempts, err: err.message }, 'sheet-pusher: excepción');
  }
  return true;
}

/**
 * Loop: procesa todos los pendientes que pueda hasta vaciar la cola.
 * Después espera el próximo tick.
 */
async function tick() {
  // Procesar hasta vaciar la cola (con tope defensivo para no bloquear si hay
  // un loop raro).
  for (let i = 0; i < 200; i++) {
    const processed = await processOne();
    if (!processed) break;
  }
}

function startSheetPusherWorker() {
  let stopped = false;
  let inTick = false;

  const run = async () => {
    if (stopped || inTick) return;
    inTick = true;
    try {
      await tick();
    } catch (err) {
      log.error({ err: err.message }, 'sheet-pusher: tick error');
    } finally {
      inTick = false;
    }
  };

  const handle = setInterval(run, TICK_MS);
  // Primer tick inmediato (para procesar lo que ya esté encolado al arrancar).
  setImmediate(run);

  return {
    close: async () => {
      stopped = true;
      clearInterval(handle);
    }
  };
}

module.exports = { startSheetPusherWorker };
