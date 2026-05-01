/**
 * Horario laboral Argentina (UTC-3 fijo, sin DST).
 * L-V 9:00 a 18:00. Sábado, domingo y feriados (TODO) son no-laborables.
 *
 * Política para programar el recordatorio `pendiente_3hs`:
 *   send_at = createdAt + 3h, ajustado:
 *     - si cae L-V 9-18 ART → ese mismo timestamp
 *     - si cae antes de las 9 (L-V) → 9:00 AM ART ese mismo día
 *     - si cae >= 18 (L-V) → 9:00 AM ART del próximo día laboral
 *     - si cae sábado/domingo → 9:00 AM ART del próximo lunes
 */

const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3

function arComponents(utcDate) {
  const ar = new Date(utcDate.getTime() - AR_OFFSET_MS);
  return {
    dow: ar.getUTCDay(), // 0=dom, 6=sab
    hour: ar.getUTCHours(),
    arDate: ar,
  };
}

function arToUtc(arDate) {
  return new Date(arDate.getTime() + AR_OFFSET_MS);
}

function computeBaseSendAt(createdAt) {
  let target = new Date(createdAt.getTime() + 3 * 60 * 60 * 1000);

  for (let i = 0; i < 8; i++) {
    const { dow, hour, arDate } = arComponents(target);

    if (dow === 6) {
      arDate.setUTCDate(arDate.getUTCDate() + 2);
      arDate.setUTCHours(9, 0, 0, 0);
      return arToUtc(arDate);
    }
    if (dow === 0) {
      arDate.setUTCDate(arDate.getUTCDate() + 1);
      arDate.setUTCHours(9, 0, 0, 0);
      return arToUtc(arDate);
    }
    if (hour < 9) {
      arDate.setUTCHours(9, 0, 0, 0);
      return arToUtc(arDate);
    }
    if (hour >= 18) {
      arDate.setUTCDate(arDate.getUTCDate() + 1);
      arDate.setUTCHours(9, 0, 0, 0);
      target = arToUtc(arDate);
      continue;
    }
    return target;
  }
  return target;
}

/**
 * `jitterSeed` (típicamente order_number): agrega `seed % 120` minutos al
 * timestamp base para repartir el envío en una ventana de 2hs y evitar el
 * bunching de cientos de pedidos a la misma hora exacta. Si el offset empuja
 * el timestamp fuera de 9-18 ART, se descarta (queda en el base original).
 */
function nextBusinessSendAtAR(createdAt, jitterSeed = 0) {
  const base = computeBaseSendAt(createdAt);
  const jitterMin = Math.abs(Number(jitterSeed) || 0) % 120;
  if (jitterMin === 0) return base;

  const candidate = new Date(base.getTime() + jitterMin * 60 * 1000);
  const { hour } = arComponents(candidate);
  if (hour >= 18 || hour < 9) return base;
  return candidate;
}

module.exports = { nextBusinessSendAtAR };
