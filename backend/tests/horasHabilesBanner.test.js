const { horasHabilesBanner, _internal } = require('../lib/horas-habiles-banner');

// Helper: construye un Date que representa "Y/M/D H:M en hora Argentina".
// AR = UTC-3, sin DST. Para llegar al timestamp UTC equivalente, sumamos 3hs.
function ar(year, monthIdx, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, monthIdx, day, hour + 3, minute, 0));
}

// Anclas (verificadas con node): 2026-05-11 = lunes, 2026-05-15 = viernes,
// 2026-05-16/17 = sáb/dom, 2026-05-18 = lunes siguiente.
const MON = (h, m = 0) => ar(2026, 4, 11, h, m);
const TUE = (h, m = 0) => ar(2026, 4, 12, h, m);
const THU = (h, m = 0) => ar(2026, 4, 14, h, m);
const FRI = (h, m = 0) => ar(2026, 4, 15, h, m);
const SAT = (h, m = 0) => ar(2026, 4, 16, h, m);
const SUN = (h, m = 0) => ar(2026, 4, 17, h, m);
const NEXT_MON = (h, m = 0) => ar(2026, 4, 18, h, m);
const NEXT_TUE = (h, m = 0) => ar(2026, 4, 19, h, m);

describe('horasHabilesBanner', () => {
  test('end <= start retorna 0', () => {
    expect(horasHabilesBanner(MON(10), MON(10))).toBe(0);
    expect(horasHabilesBanner(MON(10), MON(9))).toBe(0);
  });

  test('lun 10 → mar 10 (sin finde) = 24hs', () => {
    expect(horasHabilesBanner(MON(10), TUE(10))).toBeCloseTo(24, 6);
  });

  test('vie 17 → vie 19 = 1hs (ventana muerta arranca a las 18)', () => {
    expect(horasHabilesBanner(FRI(17), FRI(19))).toBeCloseTo(1, 6);
  });

  test('vie 17 → lun 10 = 2hs (1h del vie + 1h del lun)', () => {
    expect(horasHabilesBanner(FRI(17), NEXT_MON(10))).toBeCloseTo(2, 6);
  });

  test('vie 19 → lun 10 = 1hs (vie 19 ya está dentro de la muerta)', () => {
    expect(horasHabilesBanner(FRI(19), NEXT_MON(10))).toBeCloseTo(1, 6);
  });

  test('sáb 10 → lun 12 = 3hs (lun 09→12)', () => {
    expect(horasHabilesBanner(SAT(10), NEXT_MON(12))).toBeCloseTo(3, 6);
  });

  test('dom 14 → lun 11 = 2hs (lun 09→11)', () => {
    expect(horasHabilesBanner(SUN(14), NEXT_MON(11))).toBeCloseTo(2, 6);
  });

  test('jue 17 → lun 11 = 27hs (7h jue + 18h vie + 2h lun)', () => {
    expect(horasHabilesBanner(THU(17), NEXT_MON(11))).toBeCloseTo(27, 6);
  });

  test('lun 10 → lun siguiente 10 = 105hs (168 - 63 finde)', () => {
    expect(horasHabilesBanner(MON(10), NEXT_MON(10))).toBeCloseTo(105, 6);
  });

  test('mar 10 → mar siguiente 10 = 105hs (atraviesa un solo finde)', () => {
    expect(horasHabilesBanner(TUE(10), NEXT_TUE(10))).toBeCloseTo(105, 6);
  });

  test('entrada en plena ventana muerta (sáb 10) → vie siguiente 18hs', () => {
    // sáb 10 está dentro de muerta → arranca a contar lun 09.
    // lun 09 → vie 18 = 4 días completos (lun,mar,mié,jue) + 9hs del vie
    //         = 4*24 + 9 = 105hs
    expect(horasHabilesBanner(SAT(10), ar(2026, 4, 22, 18))).toBeCloseTo(105, 6);
  });

  test('entrada vie 18:00 exactas → lun 09:00 exactas = 0hs', () => {
    expect(horasHabilesBanner(FRI(18), NEXT_MON(9))).toBeCloseTo(0, 6);
  });

  test('acepta strings ISO', () => {
    const start = FRI(17).toISOString();
    const end = FRI(19).toISOString();
    expect(horasHabilesBanner(start, end)).toBeCloseTo(1, 6);
  });

  test('acepta números (timestamp ms)', () => {
    expect(horasHabilesBanner(MON(10).getTime(), TUE(10).getTime())).toBeCloseTo(24, 6);
  });

  test('valores inválidos retornan 0', () => {
    expect(horasHabilesBanner(null, new Date())).toBe(0);
    expect(horasHabilesBanner('not a date', new Date())).toBe(0);
  });
});

describe('viernes18hsMasReciente', () => {
  const { viernes18hsMasReciente } = _internal;

  test('un viernes después de las 18hs → ese mismo viernes 18hs', () => {
    expect(viernes18hsMasReciente(FRI(19).getTime())).toBe(FRI(18).getTime());
  });

  test('un viernes antes de las 18hs → viernes anterior 18hs', () => {
    const prevFri = ar(2026, 4, 8, 18); // 2026-05-08 = viernes anterior
    expect(viernes18hsMasReciente(FRI(17).getTime())).toBe(prevFri.getTime());
  });

  test('domingo → viernes anterior 18hs', () => {
    expect(viernes18hsMasReciente(SUN(14).getTime())).toBe(FRI(18).getTime());
  });

  test('lunes → viernes anterior 18hs', () => {
    expect(viernes18hsMasReciente(NEXT_MON(10).getTime())).toBe(FRI(18).getTime());
  });

  test('jueves → viernes de la semana ANTERIOR 18hs', () => {
    const prevFri = ar(2026, 4, 8, 18);
    expect(viernes18hsMasReciente(THU(17).getTime())).toBe(prevFri.getTime());
  });
});
