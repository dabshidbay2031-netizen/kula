// @vitest-environment node
/**
 * Tier pricing decides what a wholesale buyer is charged, so the boundaries
 * are pinned down: the user's own example is 100 pcs @ $2, 100–200 @ $1.70,
 * 200+ @ $1.50.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeTiers, tierForQty, unitPriceFor, lineTotalFor, tierSavingPerUnit, tierRangeLabel,
} from '@/lib/tierPricing';
import type { PriceTier } from '@/lib/types';

// The example from the brief.
const TIERS: PriceTier[] = [
  { minQty: 100, maxQty: 199,  price: 2.00 },
  { minQty: 200, maxQty: 299,  price: 1.70 },
  { minQty: 300, maxQty: null, price: 1.50 },
];

describe('unitPriceFor', () => {
  const BASE = 2.5;

  it('falls back to the base price below the first tier', () => {
    expect(unitPriceFor(BASE, TIERS, 1)).toBe(2.5);
    expect(unitPriceFor(BASE, TIERS, 99)).toBe(2.5);
  });

  it('applies each tier at its threshold', () => {
    expect(unitPriceFor(BASE, TIERS, 100)).toBe(2.00);
    expect(unitPriceFor(BASE, TIERS, 200)).toBe(1.70);
    expect(unitPriceFor(BASE, TIERS, 300)).toBe(1.50);
  });

  it('holds a tier across its whole range', () => {
    expect(unitPriceFor(BASE, TIERS, 150)).toBe(2.00);
    expect(unitPriceFor(BASE, TIERS, 199)).toBe(2.00);
    expect(unitPriceFor(BASE, TIERS, 250)).toBe(1.70);
    expect(unitPriceFor(BASE, TIERS, 5000)).toBe(1.50);  // open-ended top tier
  });

  it('never charges more per unit for buying more', () => {
    let prev = Infinity;
    for (const q of [1, 50, 100, 150, 200, 250, 300, 1000]) {
      const unit = unitPriceFor(BASE, TIERS, q);
      expect(unit).toBeLessThanOrEqual(prev);
      prev = unit;
    }
  });

  it('uses the base price when there are no tiers', () => {
    expect(unitPriceFor(BASE, [], 500)).toBe(2.5);
    expect(unitPriceFor(BASE, null, 500)).toBe(2.5);
    expect(unitPriceFor(BASE, undefined, 500)).toBe(2.5);
  });
});

describe('tierForQty', () => {
  it('returns null below the first threshold or for a non-positive qty', () => {
    expect(tierForQty(TIERS, 99)).toBeNull();
    expect(tierForQty(TIERS, 0)).toBeNull();
    expect(tierForQty(TIERS, -5)).toBeNull();
  });

  it('prefers the cheaper tier when ranges overlap', () => {
    const overlapping: PriceTier[] = [
      { minQty: 100, maxQty: null, price: 2.00 },
      { minQty: 200, maxQty: null, price: 1.50 },
    ];
    expect(tierForQty(overlapping, 250)?.price).toBe(1.50);
  });

  it('is unaffected by the order tiers were entered in', () => {
    const shuffled = [TIERS[2], TIERS[0], TIERS[1]];
    expect(unitPriceFor(2.5, shuffled, 200)).toBe(1.70);
  });
});

describe('normalizeTiers', () => {
  it('drops rows that cannot price anything', () => {
    const messy = [
      { minQty: 0,   maxQty: null, price: 1 },      // no threshold
      { minQty: -5,  maxQty: null, price: 1 },      // negative
      { minQty: 10,  maxQty: null, price: NaN },    // unusable price
      { minQty: 10,  maxQty: null, price: 1.25 },   // keeper
    ] as PriceTier[];
    const out = normalizeTiers(messy);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(1.25);
  });

  it('sorts by threshold and truncates fractional quantities', () => {
    const out = normalizeTiers([
      { minQty: 200.7, maxQty: null, price: 1 },
      { minQty: 100.2, maxQty: 199.9, price: 2 },
    ] as PriceTier[]);
    expect(out.map(t => t.minQty)).toEqual([100, 200]);
    expect(out[0].maxQty).toBe(199);
  });

  it('returns [] for anything that is not an array', () => {
    expect(normalizeTiers(null)).toEqual([]);
    expect(normalizeTiers(undefined)).toEqual([]);
  });
});

describe('lineTotalFor + savings', () => {
  it('multiplies the tier price by the quantity', () => {
    expect(lineTotalFor(2.5, TIERS, 100)).toBe(200);    // 100 × 2.00
    expect(lineTotalFor(2.5, TIERS, 200)).toBe(340);    // 200 × 1.70
    expect(lineTotalFor(2.5, TIERS, 300)).toBe(450);    // 300 × 1.50
  });

  it('is zero for a zero or negative quantity', () => {
    expect(lineTotalFor(2.5, TIERS, 0)).toBe(0);
    expect(lineTotalFor(2.5, TIERS, -3)).toBe(0);
  });

  it('reports the per-unit saving, never negative', () => {
    expect(tierSavingPerUnit(2.5, TIERS, 300)).toBe(1);   // 2.50 → 1.50
    expect(tierSavingPerUnit(2.5, TIERS, 10)).toBe(0);    // no tier yet
    // A "tier" dearer than the base price must not show as a negative saving.
    expect(tierSavingPerUnit(1, [{ minQty: 1, maxQty: null, price: 5 }], 10)).toBe(0);
  });
});

describe('tierRangeLabel', () => {
  it('renders closed and open-ended ranges', () => {
    expect(tierRangeLabel({ minQty: 100, maxQty: 199, price: 2 })).toBe('100 – 199');
    expect(tierRangeLabel({ minQty: 300, maxQty: null, price: 1.5 })).toBe('300+');
  });
});
