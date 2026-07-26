import { describe, it, expect } from 'vitest';
import {
  normalizeGender, normalizeBirthYear, ageFromBirthYear, ageBracket,
  birthYearOptions, MIN_AGE, MAX_AGE,
} from '@/lib/demographics';

const NOW = new Date('2026-07-27T00:00:00Z');

describe('gender', () => {
  it('accepts the four stored values', () => {
    for (const g of ['', 'male', 'female', 'other']) {
      expect(normalizeGender(g)).toBe(g);
    }
  });

  it('treats anything else as "prefer not to say" rather than storing junk', () => {
    expect(normalizeGender('Male')).toBe('male');      // case-insensitive
    expect(normalizeGender('  female ')).toBe('female');
    expect(normalizeGender('attack-string')).toBe('');
    expect(normalizeGender(undefined)).toBe('');
    expect(normalizeGender(42)).toBe('');
  });
});

describe('birth year', () => {
  it('accepts a plausible year', () => {
    expect(normalizeBirthYear(1995, NOW)).toBe(1995);
    expect(normalizeBirthYear('1995', NOW)).toBe(1995);
  });

  it('rejects someone below the minimum age', () => {
    expect(normalizeBirthYear(NOW.getFullYear() - (MIN_AGE - 1), NOW)).toBeNull();
  });

  it('accepts exactly the minimum age', () => {
    expect(normalizeBirthYear(NOW.getFullYear() - MIN_AGE, NOW)).toBe(NOW.getFullYear() - MIN_AGE);
  });

  it('rejects a future year and an implausible one', () => {
    expect(normalizeBirthYear(NOW.getFullYear() + 5, NOW)).toBeNull();
    expect(normalizeBirthYear(NOW.getFullYear() - (MAX_AGE + 1), NOW)).toBeNull();
  });

  it('rejects nonsense instead of skewing a bracket', () => {
    expect(normalizeBirthYear('', NOW)).toBeNull();
    expect(normalizeBirthYear(null, NOW)).toBeNull();
    expect(normalizeBirthYear('nineteen ninety', NOW)).toBeNull();
    expect(normalizeBirthYear(-1995, NOW)).toBeNull();
  });
});

describe('age is derived, never stored', () => {
  it('computes the current age from the birth year', () => {
    expect(ageFromBirthYear(1995, NOW)).toBe(31);
  });

  it('stays correct as time passes — the reason we do not store age', () => {
    const born = 2000;
    expect(ageFromBirthYear(born, new Date('2026-01-01'))).toBe(26);
    expect(ageFromBirthYear(born, new Date('2030-01-01'))).toBe(30);
  });

  it('returns null when the shopper declined', () => {
    expect(ageFromBirthYear(null, NOW)).toBeNull();
    expect(ageFromBirthYear(undefined, NOW)).toBeNull();
  });
});

describe('ad targeting brackets', () => {
  const cases: [number, string][] = [
    [NOW.getFullYear() - 14, '13-17'],
    [NOW.getFullYear() - 20, '18-24'],
    [NOW.getFullYear() - 30, '25-34'],
    [NOW.getFullYear() - 40, '35-44'],
    [NOW.getFullYear() - 50, '45-54'],
    [NOW.getFullYear() - 60, '55-64'],
    [NOW.getFullYear() - 80, '65+'],
  ];
  for (const [year, bracket] of cases) {
    it(`born ${year} → ${bracket}`, () => {
      expect(ageBracket(year, NOW)).toBe(bracket);
    });
  }

  it('has no bracket for a shopper who declined', () => {
    expect(ageBracket(null, NOW)).toBeNull();
  });

  it('puts every boundary in exactly one bracket', () => {
    for (let age = MIN_AGE; age <= 100; age++) {
      expect(ageBracket(NOW.getFullYear() - age, NOW)).not.toBeNull();
    }
  });
});

describe('birth year dropdown', () => {
  it('offers only years inside the accepted range, newest first', () => {
    const opts = birthYearOptions(NOW);
    expect(opts[0]).toBe(NOW.getFullYear() - MIN_AGE);
    expect(opts[opts.length - 1]).toBe(NOW.getFullYear() - MAX_AGE);
    // Every option must survive validation — the form can't offer a value the
    // server would then reject.
    for (const y of opts) expect(normalizeBirthYear(y, NOW)).toBe(y);
  });
});
