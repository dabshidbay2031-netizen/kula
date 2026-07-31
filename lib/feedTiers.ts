/**
 * Feed priority tiers — the admin-controlled half of the Explore ranking model.
 *
 * Deliberately split out of `lib/feedRanking.ts`: that module is `'use client'`
 * (it pulls the per-visit shuffle seed), and a `'use client'` module imported
 * from a route handler resolves to opaque client references on the server, so
 * its functions cannot be called there. This file has NO directive and no React
 * dependency, so the API route, the admin UI, and the Explore grid all share
 * exactly one definition of what a tier is and how config is validated —
 * instead of the route re-implementing a second, drifting sanitizer.
 *
 * `lib/feedRanking.ts` re-exports everything here, so existing imports of these
 * names from that module keep working.
 */

/** The four admin-facing tiers. Weights are the underlying knobs. */
export type Tier = 'normal' | 'reduced' | 'low' | 'hidden';

export const TIER_WEIGHT: Record<Tier, number> = {
  normal:  1.0,
  reduced: 0.5,
  low:     0.15,
  hidden:  0.0,
};

/** Labels for the admin UI, in display order. */
export const TIER_OPTIONS: { value: Tier; label: string }[] = [
  { value: 'normal',  label: 'Normal' },
  { value: 'reduced', label: 'Reduced' },
  { value: 'low',     label: 'Low' },
  { value: 'hidden',  label: 'Hidden' },
];

/** Tint per tier for badges/selects — matches the admin StatusBadge style. */
export const TIER_COLOR: Record<Tier, string> = {
  normal:  '#10B981',
  reduced: '#F59E0B',
  low:     '#F97316',
  hidden:  '#EF4444',
};

/**
 * Admin-controlled feed configuration. Stored as one JSONB row in
 * `site_settings` (key = 'feed_tiers'). Every map is optional; a missing key
 * for any id resolves to Normal — so a fresh install behaves exactly like
 * today until an admin sets something.
 */
export interface FeedTiers {
  /** supplierId (as string) → tier */
  stores?:     Record<string, Tier>;
  /** categoryId → tier */
  categories?: Record<string, Tier>;
  /** subCategoryId → tier — takes precedence over its parent category */
  subs?:       Record<string, Tier>;
  /** productId (as string) → tier — highest precedence, overrides everything */
  products?:   Record<string, Tier>;
  /** Max cards from one store in any 10-card window. Default 3. 1–9. */
  capPer10?:   number;
  updatedAt?:  string;
}

/** All tiers empty → the feed behaves identically to a plain shuffle. */
export const EMPTY_TIERS: FeedTiers = {};

export const DEFAULT_CAP_PER_10 = 3;

/** True if a value is one of the four allowed tier strings. */
export function isTier(v: unknown): v is Tier {
  return v === 'normal' || v === 'reduced' || v === 'low' || v === 'hidden';
}

/**
 * Resolve the effective tier for ONE product, honouring the precedence chain:
 * product > subcategory > category > store > Normal.
 */
export function tierFor(
  p: { id: number; supplierId?: number | null; category: string; subCategory?: string | null },
  tiers: FeedTiers,
): Tier {
  const pid = String(p.id);
  if (tiers.products && isTier(tiers.products[pid]))   return tiers.products[pid];
  if (p.subCategory && tiers.subs && isTier(tiers.subs[p.subCategory])) return tiers.subs[p.subCategory!];
  if (tiers.categories && isTier(tiers.categories[p.category])) return tiers.categories[p.category];
  if (p.supplierId != null && tiers.stores && isTier(tiers.stores[String(p.supplierId)])) {
    return tiers.stores[String(p.supplierId)];
  }
  return 'normal';
}

/** Coerce arbitrary config (from the DB / client) into a clean FeedTiers. Any
 *  unknown tier value is dropped (treated as absent → Normal). Bounds the cap. */
export function sanitizeTiers(input: unknown): FeedTiers {
  const o = (input ?? {}) as Partial<FeedTiers>;
  const cleanMap = (m: unknown): Record<string, Tier> | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const out: Record<string, Tier> = {};
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (isTier(v)) out[String(k)] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const cap = typeof o.capPer10 === 'number'
    ? Math.max(1, Math.min(9, Math.floor(o.capPer10)))
    : undefined;
  const out: FeedTiers = {
    stores: cleanMap(o.stores),
    categories: cleanMap(o.categories),
    subs: cleanMap(o.subs),
    products: cleanMap(o.products),
  };
  if (cap !== undefined) out.capPer10 = cap;
  if (typeof o.updatedAt === 'string') out.updatedAt = o.updatedAt;
  return out;
}

/** Effective cap, bounded to a sane 1–9 window. */
export function effectiveCap(tiers: FeedTiers): number {
  return Math.max(1, Math.min(9, tiers.capPer10 ?? DEFAULT_CAP_PER_10));
}

/** How many tier assignments this config actually holds — drives the admin
 *  "N rules set" summary and tells an operator at a glance that the feed is
 *  no longer running in its default, unweighted state. */
export function countRules(t: FeedTiers): number {
  return (Object.keys(t.stores     ?? {}).length)
       + (Object.keys(t.categories ?? {}).length)
       + (Object.keys(t.subs       ?? {}).length)
       + (Object.keys(t.products   ?? {}).length);
}
