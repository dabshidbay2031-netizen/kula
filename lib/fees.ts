/**
 * Platform transaction fee.
 *
 * A 3% fee is added to the BUYER's total on online-paid orders. A store can opt
 * to absorb it per-product ("transaction fee on us") — the buyer then pays the
 * listed price and the fee comes out of the store's earnings instead.
 *
 * Either way the money is the platform's, not the store's, so the payout wallet
 * must never treat it as store revenue (see /api/payouts).
 *
 * Cash / POS sales are exempt: nothing is being processed online there.
 */

export const PLATFORM_FEE_RATE = 0.03;

/** Payment methods that route through an online wallet — these carry the fee. */
export const ONLINE_PAYMENT_METHODS = new Set(['sifalo', 'waafi', 'evc', 'edahab']);

export function isOnlinePayment(method: string | null | undefined): boolean {
  return ONLINE_PAYMENT_METHODS.has(String(method ?? '').toLowerCase());
}

export interface FeeLine {
  price: number;
  qty:   number;
  /** The store chose to pay this product's fee itself. */
  feeAbsorbedByStore?: boolean;
}

export interface FeeBreakdown {
  /** Added on top of what the buyer pays. */
  buyerFee: number;
  /** Deducted from what the store receives. */
  storeFee: number;
  /** buyerFee + storeFee — the platform's total take. */
  totalFee: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Split the 3% across buyer and store according to each line's absorb flag.
 * Returns all zeros for cash/POS (or any non-online method).
 */
export function computePlatformFee(lines: FeeLine[], paymentMethod: string | null | undefined): FeeBreakdown {
  if (!isOnlinePayment(paymentMethod)) return { buyerFee: 0, storeFee: 0, totalFee: 0 };

  let buyer = 0;
  let store = 0;
  for (const l of lines) {
    const lineTotal = (Number(l.price) || 0) * (Number(l.qty) || 0);
    if (lineTotal <= 0) continue;
    const fee = lineTotal * PLATFORM_FEE_RATE;
    if (l.feeAbsorbedByStore) store += fee;
    else                      buyer += fee;
  }

  const buyerFee = round2(buyer);
  const storeFee = round2(store);
  return { buyerFee, storeFee, totalFee: round2(buyerFee + storeFee) };
}

/** Label for the checkout/receipt line. */
export const PLATFORM_FEE_LABEL = `Transaction fee (${Math.round(PLATFORM_FEE_RATE * 100)}%)`;
