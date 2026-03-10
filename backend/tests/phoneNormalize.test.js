const { normalizePhone } = require('../utils/phoneNormalize');

describe('normalizePhone', () => {
  it('normalizes +54 9 11 format', () => {
    expect(normalizePhone('+5491112345678')).toBe('541112345678');
  });

  it('normalizes +54 11 format (without 9)', () => {
    expect(normalizePhone('+541112345678')).toBe('541112345678');
  });

  it('normalizes 54 9 11 format (no plus)', () => {
    expect(normalizePhone('5491112345678')).toBe('541112345678');
  });

  it('normalizes 11 format (local)', () => {
    expect(normalizePhone('1112345678')).toBe('541112345678');
  });

  it('normalizes 011 format', () => {
    expect(normalizePhone('01112345678')).toBe('541112345678');
  });

  it('handles formatted numbers with spaces/dashes', () => {
    expect(normalizePhone('+54 9 11 1234-5678')).toBe('541112345678');
  });

  it('returns null for empty input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('returns null for too short numbers', () => {
    expect(normalizePhone('123')).toBeNull();
  });
});
