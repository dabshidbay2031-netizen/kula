/**
 * Wholesale tier pricing — "100 pcs at $2, 100–200 at $1.70, 200+ at $1.50".
 *
 * A tier is `{ minQty, maxQty, price }` with `maxQty: null` meaning "and above".
 * The `products.price_tiers` column and the `PriceTier` type already existed;
 * this is the logic that makes them actually price an order.
 *
 * The rule: the unit price is taken from the HIGHEST tier whose minQty the
 * order quantity reaches. Buying more never costs more per unit, even if a
 * seller enters overlapping or out-of-order tiers.
 */

import type { PriceTier } from '@/lib/types';

/** Tiers sorted by threshold, with unusable rows dropped. */
export function normalizeTiers(tiers: PriceTier[] | null | undefined): PriceTier[] {
  if (!Array.isArray(tiers)) return [];
  return tiers
    .filter(t =>
      t
      && Number.isFinite(Number(t.minQty)) && Number(t.minQty) > 0
      && Number.isFinite(Number(t.price))  && Number(t.price)  >= 0)
    .map(t => ({
      minQty: Math.trunc(Number(t.minQty)),
      maxQty: t.maxQty == null || !Number.isFinite(Number(t.maxQty)) ? null : Math.trunc(Number(t.maxQty)),
      price:  Number(t.price),
    }))
    .sort((a, b) => a.minQty - b.minQty);
}

/**
 * The tier that applies at `qty`, or null when none does (below the first
 * threshold → the product's normal price stands).
 *
 * Bounds are inclusive on both ends, matching how sellers phrase them
 * ("100 to 200"). Where tiers overlap the LAST qualifying one wins, so the
 * cheaper bulk rate is never shadowed by an earlier row.
 */
export function tierForQty(tiers: PriceTier[] | null | undefined, qty: number): PriceTier | null {
  const q = Math.trunc(Number(qty) || 0);
  if (q <= 0) return null;
  let match: PriceTier | null = null;
  for (const t of normalizeTiers(tiers)) {
    if (q >= t.minQty && (t.maxQty == null || q <= t.maxQty)) match = t;
  }
  return match;
}

/** Unit price at `qty`: the matching tier's price, else the base price. */
export function unitPriceFor(basePrice: number, tiers: PriceTier[] | null | undefined, qty: number): number {
  const t = tierForQty(tiers, qty);
  return t ? t.price : (Number(basePrice) || 0);
}

/** Line total at `qty`, rounded to cents. */
export function lineTotalFor(basePrice: number, tiers: PriceTier[] | null | undefined, qty: number): number {
  const q = Math.max(0, Math.trunc(Number(qty) || 0));
  return Math.round(unitPriceFor(basePrice, tiers, q) * q * 100) / 100;
}

/** How much a buyer saves per unit vs the base price (0 when no tier applies). */
export function tierSavingPerUnit(basePrice: number, tiers: PriceTier[] | null | undefined, qty: number): number {
  const base = Number(basePrice) || 0;
  const unit = unitPriceFor(base, tiers, qty);
  return Math.max(0, Math.round((base - unit) * 100) / 100);
}

/** "100 – 200" / "200+" — the range label for a tier row. */
export function tierRangeLabel(t: PriceTier): string {
  return t.maxQty == null ? `${t.minQty}+` : `${t.minQty} – ${t.maxQty}`;
}

/* ── Form <-> API conversion ──────────────────────────────────────────────
   The editor holds strings so a half-typed number isn't coerced to 0 mid-key;
   these convert at the boundary. */

export interface TierFormRow { minQty: string; maxQty: string; price: string }

/** API tiers → editable rows. */
export function tiersToForm(tiers: PriceTier[] | null | undefined): TierFormRow[] {
  return normalizeTiers(tiers).map(t => ({
    minQty: String(t.minQty),
    maxQty: t.maxQty == null ? '' : String(t.maxQty),
    price:  String(t.price),
  }));
}

/** Editable rows → API tiers, dropping incomplete ones (blank max = "and above"). */
export function formToTiers(rows: TierFormRow[] | null | undefined): PriceTier[] {
  if (!Array.isArray(rows)) return [];
  return normalizeTiers(rows.map(r => ({
    minQty: parseInt(r.minQty, 10),
    maxQty: r.maxQty.trim() === '' ? null : parseInt(r.maxQty, 10),
    price:  parseFloat(r.price),
  })) as PriceTier[]);
}
