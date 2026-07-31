// @vitest-environment node
/**
 * Export date ranges.
 *
 * These decide which rows land in a shop's backup. An off-by-one here does not
 * throw — it silently hands someone a file that is missing a day of takings, or
 * an empty file for a single-day request that looks like "we had no sales".
 */
import { describe, it, expect } from 'vitest';
import { resolveExportRange, rangeSlug } from '@/lib/dashboardPeriod';

const ok = (r: ReturnType<typeof resolveExportRange>) => {
  if ('error' in r) throw new Error(`expected a range, got error: ${r.error}`);
  return r;
};

describe('custom from/to ranges', () => {
  it('covers a single day in full — `to` is inclusive', () => {
    const r = ok(resolveExportRange({ from: '2026-03-04', to: '2026-03-04' }));
    // 00:00 Mogadishu on the 4th is 21:00 UTC on the 3rd.
    expect(r.start!.toISOString()).toBe('2026-03-03T21:00:00.000Z');
    expect(r.end!.toISOString()).toBe('2026-03-04T21:00:00.000Z');
    expect(r.end!.getTime() - r.start!.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('a sale at 23:30 Mogadishu on the requested day falls INSIDE the range', () => {
    const r = ok(resolveExportRange({ from: '2026-03-04', to: '2026-03-04' }));
    const lateSale = new Date('2026-03-04T23:30:00+03:00');
    expect(lateSale.getTime()).toBeGreaterThanOrEqual(r.start!.getTime());
    expect(lateSale.getTime()).toBeLessThan(r.end!.getTime());
  });

  it('a sale at 00:30 the FOLLOWING day falls outside', () => {
    const r = ok(resolveExportRange({ from: '2026-03-04', to: '2026-03-04' }));
    const nextDay = new Date('2026-03-05T00:30:00+03:00');
    expect(nextDay.getTime()).toBeGreaterThanOrEqual(r.end!.getTime());
  });

  it('spans a multi-day window inclusively', () => {
    const r = ok(resolveExportRange({ from: '2026-03-04', to: '2026-03-17' }));
    const days = (r.end!.getTime() - r.start!.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(14);            // 4th–17th inclusive
    expect(r.label).toBe('4 Mar 2026 – 17 Mar 2026');
  });

  it('labels a single day without a range dash', () => {
    expect(ok(resolveExportRange({ from: '2026-03-04', to: '2026-03-04' })).label).toBe('4 Mar 2026');
  });

  it('from/to win over an also-supplied period', () => {
    const r = ok(resolveExportRange({ period: 'year', from: '2026-03-04', to: '2026-03-05' }));
    expect(r.label).toBe('4 Mar 2026 – 5 Mar 2026');
  });
});

describe('custom range validation', () => {
  it('rejects only one half of the pair', () => {
    expect(resolveExportRange({ from: '2026-03-04' })).toHaveProperty('error');
    expect(resolveExportRange({ to:   '2026-03-04' })).toHaveProperty('error');
  });

  it('rejects a malformed date rather than exporting the wrong window', () => {
    expect(resolveExportRange({ from: '04/03/2026', to: '2026-03-05' })).toHaveProperty('error');
    expect(resolveExportRange({ from: '2026-3-4',   to: '2026-03-05' })).toHaveProperty('error');
  });

  it('rejects a reversed range', () => {
    const r = resolveExportRange({ from: '2026-03-17', to: '2026-03-04' });
    expect(r).toHaveProperty('error');
  });

  it('rejects an unknown period', () => {
    expect(resolveExportRange({ period: 'fortnight' })).toHaveProperty('error');
  });
});

describe('named periods', () => {
  it('"all" is unbounded — the whole-history backup', () => {
    const r = ok(resolveExportRange({ period: 'all' }));
    expect(r.start).toBeNull();
    expect(r.end).toBeNull();
    expect(rangeSlug(r)).toBe('all-time');
  });

  it('defaults to the current month when nothing is given', () => {
    const r = ok(resolveExportRange({}, new Date('2026-03-15T12:00:00Z')));
    expect(r.start).not.toBeNull();
    expect(r.label).toContain('March');
  });

  it('day/week/month/year all resolve to a bounded window', () => {
    for (const period of ['day', 'week', 'month', 'year'] as const) {
      const r = ok(resolveExportRange({ period }));
      expect(r.start!.getTime()).toBeLessThan(r.end!.getTime());
    }
  });
});

describe('rangeSlug (filenames)', () => {
  it('collapses a single day to one date', () => {
    expect(rangeSlug(ok(resolveExportRange({ from: '2026-03-04', to: '2026-03-04' })))).toBe('2026-03-04');
  });

  it('joins a multi-day window with an underscore', () => {
    expect(rangeSlug(ok(resolveExportRange({ from: '2026-03-04', to: '2026-03-17' })))).toBe('2026-03-04_2026-03-17');
  });
});
