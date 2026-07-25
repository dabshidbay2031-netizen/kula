/**
 * Time bucketing for the business dashboard's Daily / Weekly / Monthly / Yearly
 * views.
 *
 * Pure date maths, kept out of the view so it can be unit-tested: an
 * off-by-one here silently misreports a shop's takings.
 *
 * Every period returns a fixed number of consecutive buckets ending with the
 * CURRENT one, so the chart always has a stable shape (empty buckets render as
 * zero rather than collapsing the axis).
 */

export type Period = 'day' | 'week' | 'month' | 'year';

export interface PeriodBucket {
  key:   string;
  label: string;
  /** Inclusive start of the bucket. */
  start: Date;
  /** Exclusive end of the bucket. */
  end:   Date;
}

export const PERIOD_META: Record<Period, { label: string; sub: string; count: number }> = {
  day:   { label: 'Daily',   sub: 'Last 14 days',   count: 14 },
  week:  { label: 'Weekly',  sub: 'Last 8 weeks',   count: 8  },
  month: { label: 'Monthly', sub: 'Last 12 months', count: 12 },
  year:  { label: 'Yearly',  sub: 'Last 5 years',   count: 5  },
};

/** Midnight at the start of `d`'s day, in local time. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday 00:00 of `d`'s week (ISO-style weeks — Sunday belongs to the week before). */
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // Mon=0 … Sun=6
  s.setDate(s.getDate() - dow);
  return s;
}

/**
 * The consecutive buckets to plot, oldest → newest, ending with the one
 * containing `now`.
 */
export function buildBuckets(period: Period, now: Date = new Date()): PeriodBucket[] {
  const { count } = PERIOD_META[period];
  const out: PeriodBucket[] = [];

  for (let i = count - 1; i >= 0; i--) {
    let start: Date;
    let end:   Date;
    let label: string;

    if (period === 'day') {
      start = startOfDay(now);
      start.setDate(start.getDate() - i);
      end = new Date(start); end.setDate(end.getDate() + 1);
      label = start.toLocaleDateString('en-US', { day: 'numeric' });
    } else if (period === 'week') {
      start = startOfWeek(now);
      start.setDate(start.getDate() - i * 7);
      end = new Date(start); end.setDate(end.getDate() + 7);
      label = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else if (period === 'month') {
      start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      end   = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      label = start.toLocaleDateString('en-US', { month: 'short' });
    } else {
      start = new Date(now.getFullYear() - i, 0, 1);
      end   = new Date(start.getFullYear() + 1, 0, 1);
      label = String(start.getFullYear());
    }

    out.push({ key: `${period}-${start.getTime()}`, label, start, end });
  }

  return out;
}

/**
 * Index of the bucket containing `date`, or -1 when it falls outside the
 * window. Buckets are consecutive, so a linear scan is both correct and cheap
 * at these sizes (≤14).
 */
export function bucketIndexFor(date: Date, buckets: PeriodBucket[]): number {
  const t = date.getTime();
  if (Number.isNaN(t)) return -1;
  for (let i = 0; i < buckets.length; i++) {
    if (t >= buckets[i].start.getTime() && t < buckets[i].end.getTime()) return i;
  }
  return -1;
}

/** Start of the whole window — anything before this is outside the period view. */
export function windowStart(buckets: PeriodBucket[]): Date | null {
  return buckets.length ? buckets[0].start : null;
}

/* ── Reporting ────────────────────────────────────────────────────────────
   The on-screen chart shows a TREND (last 14 days, last 12 months, …), but a
   downloaded report is about one period: Daily → that day, Weekly → that week,
   Monthly → that month, Yearly → that year. These helpers describe that single
   period and break it into readable sub-rows. */

/** The single period a report covers, with a human label for its cover page. */
export function currentPeriodRange(period: Period, now: Date = new Date()): { start: Date; end: Date; label: string } {
  const D = (d: Date) => d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

  if (period === 'day') {
    const start = startOfDay(now);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { start, end, label: now.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) };
  }
  if (period === 'week') {
    const start = startOfWeek(now);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const last = new Date(end); last.setDate(last.getDate() - 1);
    return { start, end, label: `${D(start)} – ${D(last)}` };
  }
  if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { start, end, label: start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
  }
  const start = new Date(now.getFullYear(), 0, 1);
  const end   = new Date(now.getFullYear() + 1, 0, 1);
  return { start, end, label: String(now.getFullYear()) };
}

/**
 * Sub-rows inside the reported period:
 *   Daily   → 24 hourly rows      Weekly → 7 daily rows
 *   Monthly → one row per day     Yearly → 12 monthly rows
 */
export function buildReportBuckets(period: Period, now: Date = new Date()): PeriodBucket[] {
  const { start, end } = currentPeriodRange(period, now);
  const out: PeriodBucket[] = [];

  if (period === 'day') {
    for (let h = 0; h < 24; h++) {
      const s = new Date(start); s.setHours(h);
      const e = new Date(s);     e.setHours(h + 1);
      out.push({ key: `h-${h}`, label: `${String(h).padStart(2, '0')}:00`, start: s, end: e });
    }
    return out;
  }

  if (period === 'year') {
    for (let m = 0; m < 12; m++) {
      const s = new Date(start.getFullYear(), m, 1);
      const e = new Date(start.getFullYear(), m + 1, 1);
      out.push({ key: `m-${m}`, label: s.toLocaleDateString('en-US', { month: 'short' }), start: s, end: e });
    }
    return out;
  }

  // week + month → one row per day
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const s = new Date(d);
    const e = new Date(d); e.setDate(e.getDate() + 1);
    out.push({
      key:   `d-${s.getTime()}`,
      label: s.toLocaleDateString('en-US', period === 'week'
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short' }),
      start: s, end: e,
    });
  }
  return out;
}

/** Compact money for axis ticks and bar captions: 1234 → "$1.2k". */
export function shortMoney(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
