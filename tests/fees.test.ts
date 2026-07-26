// @vitest-environment node
/**
 * The 3% platform fee decides what a buyer is charged and what a store is
 * owed, so its edges are pinned down here: which payment methods carry it,
 * who pays when a store absorbs it, and that rounding never invents money.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlatformFee, isOnlinePayment, PLATFORM_FEE_RATE, PLATFORM_FEE_LABEL,
} from '@/lib/fees';

describe('isOnlinePayment', () => {
  it('is true only for online wallet methods', () => {
    for (const m of ['sifalo', 'waafi', 'evc', 'edahab']) expect(isOnlinePayment(m)).toBe(true);
    for (const m of ['cash', 'card', 'cod', 'bulk', 'invoice', '']) expect(isOnlinePayment(m)).toBe(false);
  });

  it('is case-insensitive and null-safe', () => {
    expect(isOnlinePayment('SIFALO')).toBe(true);
    expect(isOnlinePayment(null)).toBe(false);
    expect(isOnlinePayment(undefined)).toBe(false);
  });
});

describe('computePlatformFee', () => {
  const line = { price: 100, qty: 1 };

  it('charges the buyer 3% on an online order', () => {
    const f = computePlatformFee([line], 'sifalo');
    expect(f.buyerFee).toBe(3);
    expect(f.storeFee).toBe(0);
    expect(f.totalFee).toBe(3);
  });

  it('charges nothing at all on cash / POS', () => {
    expect(computePlatformFee([line], 'cash')).toEqual({ buyerFee: 0, storeFee: 0, totalFee: 0 });
    expect(computePlatformFee([line], 'card')).toEqual({ buyerFee: 0, storeFee: 0, totalFee: 0 });
  });

  it('moves the fee to the store when the store absorbs it', () => {
    const f = computePlatformFee([{ ...line, feeAbsorbedByStore: true }], 'waafi');
    expect(f.buyerFee).toBe(0);   // buyer pays exactly the listed price
    expect(f.storeFee).toBe(3);   // store eats it
    expect(f.totalFee).toBe(3);   // platform still collects the same
  });

  it('splits a mixed cart per line', () => {
    const f = computePlatformFee([
      { price: 100, qty: 1 },                              // buyer pays 3.00
      { price: 50,  qty: 2, feeAbsorbedByStore: true },     // store pays 3.00
    ], 'sifalo');
    expect(f.buyerFee).toBe(3);
    expect(f.storeFee).toBe(3);
    expect(f.totalFee).toBe(6);
  });

  it('accounts for quantity', () => {
    expect(computePlatformFee([{ price: 10, qty: 5 }], 'evc').buyerFee).toBe(1.5);
  });

  it('rounds to cents without losing or inventing money', () => {
    // 3% of 33.33 = 0.9999 → 1.00
    expect(computePlatformFee([{ price: 33.33, qty: 1 }], 'sifalo').buyerFee).toBe(1);
    const f = computePlatformFee([{ price: 0.01, qty: 1 }], 'sifalo');
    expect(f.buyerFee).toBe(0);                     // 0.0003 rounds away
    expect(f.totalFee).toBe(f.buyerFee + f.storeFee);
  });

  it('ignores empty, zero and negative lines', () => {
    expect(computePlatformFee([], 'sifalo').totalFee).toBe(0);
    expect(computePlatformFee([{ price: 0, qty: 5 }], 'sifalo').totalFee).toBe(0);
    expect(computePlatformFee([{ price: 10, qty: 0 }], 'sifalo').totalFee).toBe(0);
    expect(computePlatformFee([{ price: -10, qty: 1 }], 'sifalo').totalFee).toBe(0);
  });

  it('exposes a 3% rate and a matching label', () => {
    expect(PLATFORM_FEE_RATE).toBe(0.03);
    expect(PLATFORM_FEE_LABEL).toContain('3%');
  });
});
