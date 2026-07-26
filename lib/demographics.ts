/**
 * Shopper demographics — gender + age, captured at signup for audience
 * segmentation (ad targeting, category insights).
 *
 * We store BIRTH YEAR, not age. An age column is wrong the moment it's
 * written: a row saying "24" silently becomes a lie on the user's next
 * birthday, and every campaign built on it drifts. Birth year is stable, and
 * the age it implies is always current.
 *
 * Both fields are OPTIONAL. A required gender/age question costs signups and
 * forces people to lie, which poisons the very data the ads depend on — a
 * declined answer is more useful than a fabricated one.
 */

export type Gender = '' | 'male' | 'female' | 'other';

export const GENDERS: { value: Gender; label: string }[] = [
  { value: '',       label: 'Prefer not to say' },
  { value: 'male',   label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other',  label: 'Other' },
];

/** Oldest and youngest birth years we accept. 13 is the usual floor for ad
 *  profiling; below it, don't collect at all. */
export const MIN_AGE = 13;
export const MAX_AGE = 110;

export function isValidGender(v: unknown): v is Gender {
  return v === '' || v === 'male' || v === 'female' || v === 'other';
}

/** Normalise anything the client sends into a storable gender. */
export function normalizeGender(v: unknown): Gender {
  const s = String(v ?? '').trim().toLowerCase();
  return isValidGender(s) ? s : '';
}

/**
 * Validate a birth year against the age bounds.
 * Returns the year, or null when it's absent/implausible.
 */
export function normalizeBirthYear(v: unknown, now: Date = new Date()): number | null {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  const year = now.getFullYear();
  if (n > year - MIN_AGE) return null;   // too young (or a future year)
  if (n < year - MAX_AGE) return null;   // implausibly old
  return n;
}

/** Current age implied by a birth year (±1 — we don't store the birthday). */
export function ageFromBirthYear(birthYear: number | null | undefined, now: Date = new Date()): number | null {
  if (birthYear == null) return null;
  const age = now.getFullYear() - birthYear;
  return age >= 0 && age <= MAX_AGE ? age : null;
}

/** The buckets campaigns are actually targeted at. */
export const AGE_BRACKETS = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'] as const;
export type AgeBracket = typeof AGE_BRACKETS[number];

export function ageBracket(birthYear: number | null | undefined, now: Date = new Date()): AgeBracket | null {
  const age = ageFromBirthYear(birthYear, now);
  if (age == null || age < MIN_AGE) return null;
  if (age <= 17) return '13-17';
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 44) return '35-44';
  if (age <= 54) return '45-54';
  if (age <= 64) return '55-64';
  return '65+';
}

/** Selectable birth years, newest first — for a signup dropdown. */
export function birthYearOptions(now: Date = new Date()): number[] {
  const newest = now.getFullYear() - MIN_AGE;
  const oldest = now.getFullYear() - MAX_AGE;
  const out: number[] = [];
  for (let y = newest; y >= oldest; y--) out.push(y);
  return out;
}
