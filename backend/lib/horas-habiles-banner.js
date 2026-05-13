/**
 * Cálculo de horas hábiles para el banner de pedidos demorados (/deposito).
 *
 * ⚠️ NO confundir con `utils/businessHours.js`. Ese módulo sirve para SCHEDULE
 * de envíos (próximo horario L-V 9-18 AR para mandar un WhatsApp). Este sirve
 * para MEDIR cuánto tiempo lleva un pedido demorado, con una regla distinta:
 *
 *   - utils/businessHours.js:        L-V 9:00-18:00 (horario laboral acotado).
 *   - lib/horas-habiles-banner.js:   lo opuesto a la "ventana muerta" semanal
 *                                    VIE 18:00 → LUN 09:00 (AR). Todo lo demás
 *                                    cuenta como tiempo demorado, incluyendo
 *                                    horas nocturnas L-J.
 *
 * Regla del negocio (definida 2026-05-13): el tiempo dentro de la ventana
 * VIE 18:00 → LUN 09:00 en zona horaria America/Argentina/Buenos_Aires no
 * suma como tiempo demorado. Fuera de esa ventana, el reloj corre normal.
 *
 * Cada semana hay un bloque "muerto" de 63 horas
 * (Sáb completo + Dom completo + 9h del lunes + 6h del viernes).
 *
 * Argentina no tiene cambios de horario desde 2009 — el offset es fijo en
 * UTC-3 todo el año. Si esto cambiara, romper aquí (no en lugares lejanos).
 */

const AR_OFFSET_HOURS = -3;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DEAD_WINDOW_HOURS = 63; // viernes 18:00 → lunes 09:00

/**
 * Horas hábiles para el banner depo: tiempo transcurrido entre dos timestamps
 * excluyendo la ventana muerta VIE 18 → LUN 09 AR.
 *
 * @param {Date|string|number} startAt
 * @param {Date|string|number} [now=new Date()]
 * @returns {number} horas (puede ser fraccionario). 0 si end <= start.
 */
function horasHabilesBanner(startAt, now = new Date()) {
  const start = toDate(startAt);
  const end = toDate(now);
  if (!start || !end || end.getTime() <= start.getTime()) return 0;

  const totalMs = end.getTime() - start.getTime();
  const deadMs = solapamientoVentanaMuertaMs(start.getTime(), end.getTime());
  return Math.max(0, (totalMs - deadMs) / HOUR_MS);
}

/**
 * Suma la duración (ms) de los solapamientos del intervalo [startTs, endTs]
 * con las ventanas muertas semanales VIE 18 → LUN 09 (TZ AR).
 */
function solapamientoVentanaMuertaMs(startTs, endTs) {
  let total = 0;
  let deadStart = viernes18hsMasReciente(startTs);
  while (deadStart < endTs) {
    const deadEnd = deadStart + DEAD_WINDOW_HOURS * HOUR_MS;
    const overlapStart = Math.max(deadStart, startTs);
    const overlapEnd = Math.min(deadEnd, endTs);
    if (overlapEnd > overlapStart) {
      total += overlapEnd - overlapStart;
    }
    deadStart += 7 * DAY_MS;
  }
  return total;
}

/**
 * Timestamp (ms UTC) del viernes a las 18:00 hora AR más reciente que sea
 * <= referenceTs. Sirve como "inicio de la ventana muerta vigente o anterior".
 */
function viernes18hsMasReciente(referenceTs) {
  // Shift al "espacio AR" para que getUTC* devuelva componentes en hora local.
  const shifted = referenceTs + AR_OFFSET_HOURS * HOUR_MS;
  const d = new Date(shifted);
  const dow = d.getUTCDay(); // 0=dom, 1=lun, ..., 5=vie, 6=sáb
  const hour = d.getUTCHours();

  let daysBack;
  if (dow === 5) daysBack = hour >= 18 ? 0 : 7;
  else if (dow === 6) daysBack = 1;
  else daysBack = dow + 2; // dom→2, lun→3, mar→4, mié→5, jue→6

  // Construir el ts de "(día - daysBack) 18:00 AR" en componentes AR, luego
  // deshacer el shift para volver a UTC real.
  const fridayComponentsTs = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysBack,
    18, 0, 0, 0
  );
  return fridayComponentsTs - AR_OFFSET_HOURS * HOUR_MS;
}

function toDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

module.exports = {
  horasHabilesBanner,
  // exportados para tests
  _internal: { viernes18hsMasReciente, solapamientoVentanaMuertaMs, DEAD_WINDOW_HOURS },
};
